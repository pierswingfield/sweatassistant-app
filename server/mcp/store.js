const crypto = require('node:crypto');
const db = require('../db');
const { SCOPES } = require('./config');
const access = require('./access');
const fail = (message = 'Access is no longer authorized') => Object.assign(new Error(message), { code: 'ACCESS_DENIED', status: 403 });
const fingerprint = (hash) => crypto.createHash('sha256').update(hash || '').digest('hex');
function account(userId) {
  return db.db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(userId);
}
function registerClient(clientId, name) {
  if (typeof clientId !== 'string' || !clientId.length || clientId.length > 200 || typeof name !== 'string' || !name.length || name.length > 100) throw fail('Invalid client');
  db.db.prepare('INSERT INTO mcp_clients (client_id, name) VALUES (?, ?)').run(clientId, name);
}
// Internal seam for a future verified first-party consent interaction. Never an HTTP endpoint.
function createGrant({ userId, issuer, subject, clientId, scopes, gymIds, expiresAt, consentReference, allLinkedGyms = false }) {
  if (!access.accountEnabled(userId)) throw fail();
  const user = account(userId);
  if (!user || !user.password_hash || !subject || typeof subject !== 'string' || subject.length > 200 ||
      typeof issuer !== 'string' || !issuer.startsWith('https://') ||
      !db.db.prepare('SELECT 1 FROM mcp_clients WHERE client_id = ? AND disabled_at IS NULL').get(clientId) ||
      !Array.isArray(scopes) || !scopes.length || scopes.some(s => !SCOPES.includes(s)) || new Set(scopes).size !== scopes.length ||
      typeof allLinkedGyms !== 'boolean' || !Array.isArray(gymIds) || (!allLinkedGyms && !gymIds.length) || (!allLinkedGyms && gymIds.length > 10) || new Set(gymIds).size !== gymIds.length ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 864e5 ||
      typeof consentReference !== 'string' || !consentReference.length || consentReference.length > 200) throw fail('Invalid grant');
  const links = gymIds.map(gymId => {
    const link = db.getUserGym(userId, gymId);
    if (!link || link.status === 'disabled' || !access.gymEnabled(gymId)) throw fail('Gym unavailable');
    return { gymId, linkId: link.id };
  });
  const id = crypto.randomUUID();
  db.db.transaction(() => {
    db.db.prepare(`INSERT INTO mcp_grants
    (id, user_id, issuer, subject, client_id, scopes_json, gyms_json, account_fingerprint, expires_at, consent_reference)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, issuer, subject, clientId,
    JSON.stringify(scopes), JSON.stringify(links), fingerprint(user.password_hash), expiresAt, consentReference);
    if (allLinkedGyms) db.db.prepare('INSERT INTO mcp_all_linked_grants(grant_id) VALUES (?)').run(id);
  })();
  return id;
}
function authorize(identity, scope, gymId) {
  const grant = db.db.prepare(`SELECT g.* FROM mcp_grants g JOIN mcp_clients c ON c.client_id = g.client_id
    WHERE g.id = ? AND g.revoked_at IS NULL AND c.disabled_at IS NULL`).get(identity.grantId);
  const user = grant && account(grant.user_id);
  if (!grant || !user || !access.accountEnabled(grant.user_id) || grant.issuer !== identity.issuer || grant.subject !== identity.subject || grant.client_id !== identity.clientId ||
      grant.expires_at <= Date.now() || identity.expiresAt <= Date.now() ||
      fingerprint(user.password_hash) !== grant.account_fingerprint) throw fail();
  const scopes = JSON.parse(grant.scopes_json);
  if (scope && (!scopes.includes(scope) || !identity.scopes.includes(scope))) throw Object.assign(fail('Required permission is missing'), { code: 'INSUFFICIENT_SCOPE', scope });
  const allLinked = !!db.db.prepare('SELECT 1 FROM mcp_all_linked_grants WHERE grant_id=?').get(grant.id);
  const permitted = allLinked ? db.getUserGyms(grant.user_id).map(g => ({ gymId: g.gym_id, linkId: g.id })) : JSON.parse(grant.gyms_json);
  const gyms = permitted.filter(({ gymId: id, linkId }) => {
    const link = db.getUserGym(grant.user_id, id);
    return link && link.id === linkId && link.status !== 'disabled' && access.gymEnabled(id);
  }).map(g => g.gymId);
  if (gymId !== undefined && !gyms.includes(gymId)) throw fail('Gym is not permitted');
  return { userId: grant.user_id, grantId: grant.id, clientId: grant.client_id, gyms, scopes };
}
function revokeGrant(userId, id) {
  return db.db.prepare('UPDATE mcp_grants SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), id, userId).changes;
}
function revokeAll(userId) {
  return db.db.prepare('UPDATE mcp_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), userId).changes;
}
function listGrants(userId) {
  return db.db.prepare(`SELECT id, client_id, scopes_json, gyms_json, expires_at, revoked_at, last_used_at,
    EXISTS(SELECT 1 FROM mcp_all_linked_grants a WHERE a.grant_id=mcp_grants.id) all_linked
    FROM mcp_grants WHERE user_id = ? ORDER BY issued_at DESC`).all(userId);
}
function touch(id) { db.db.prepare('UPDATE mcp_grants SET last_used_at = ? WHERE id = ?').run(Date.now(), id); }
// Durable fixed windows. One SQLite transaction admits all dimensions or none.
function charge(dimensions, now = Date.now()) {
  const rows = dimensions.map(([key, limit, windowMs]) => ({ key, limit, windowMs, window: Math.floor(now / windowMs) }));
  try { return db.db.transaction(() => {
    db.db.prepare('DELETE FROM mcp_budgets WHERE expires_at <= ?').run(now);
    for (const r of rows) {
      const count = db.db.prepare('SELECT count FROM mcp_budgets WHERE budget_key = ? AND window_id = ?').get(r.key, r.window)?.count || 0;
      if (count >= r.limit) throw Object.assign(new Error('MCP budget exhausted'), { code: 'RATE_LIMITED', status: 429, retryAfter: Math.max(1, Math.ceil(((r.window + 1) * r.windowMs - now) / 1000)) });
    }
    for (const r of rows) db.db.prepare(`INSERT INTO mcp_budgets (budget_key, window_id, count, expires_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(budget_key, window_id) DO UPDATE SET count = count + 1`).run(r.key, r.window, (r.window + 1) * r.windowMs);
  })(); } catch (err) {
    if (err.code === 'RATE_LIMITED') throw err;
    throw Object.assign(new Error('Provider budget storage unavailable'), { code: 'BUDGET_UNAVAILABLE', status: 503 });
  }
}
module.exports = { registerClient, createGrant, authorize, revokeGrant, revokeAll, listGrants, touch, charge };
