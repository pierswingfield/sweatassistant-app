// Shared connection availability, independent of membership and the member's switch.
const { AsyncLocalStorage } = require('async_hooks');
const recovery = new AsyncLocalStorage();
const db = () => require('./db');
function recoveryAllowed(userId, gymId) {
  const scope = recovery.getStore();
  return !!scope && String(scope.userId) === String(userId) && scope.gymId === gymId;
}
function withRecovery(userId, gymId, work) { return recovery.run({ userId, gymId }, work); }
function unavailable(userId, gymId) {
  if (userId == null || recoveryAllowed(userId, gymId)) return false;
  const link = db().getUserGym(userId, gymId);
  return !!link && ['needs_relogin', 'syncing'].includes(link.status);
}
function expiredError(gymId) {
  return Object.assign(new Error('Log in to this gym again. Its data and automation are paused.'), { status: 401, code: 'GYM_SESSION_EXPIRED', gymId });
}
function requireLogin(userId, gymId, reason, revision = null) {
  if (db().requireGymLogin(userId, gymId, reason, revision)) {
    try { require('./calendar').regenerateSnapshot(userId); } catch (_) {}
    deliverPending().catch(() => {});
  }
  return expiredError(gymId);
}
// Bind a provider request to the exact stored session it used. Some existing
// session writers do not advance connection_revision, so the token matters too.
function sessionProof(userId, gymId, accessToken) {
  const link = db().getUserGym(userId, gymId);
  let session; try { session = JSON.parse(link?.session_json || 'null'); } catch (_) {}
  return { accessToken, revision: accessToken && session?.accessToken === accessToken ? link.connection_revision : null };
}
function rejectSession(userId, gymId, proof) {
  const current = sessionProof(userId, gymId, proof?.accessToken);
  if (Number.isInteger(proof?.revision) && current.revision === proof.revision) {
    return requireLogin(userId, gymId, 'session_rejected', proof.revision);
  }
  // The request lost a race to a newer login/session. Its response is stale;
  // callers may stop that operation but cannot invalidate the newer connection.
  return expiredError(gymId);
}
// Run exactly the one retry the caller already authorised after renewal. This
// helper never renews or repeats the operation itself, especially mutations.
async function retrySessionCall(userId, gymId, accessToken, operation) {
  const proof = sessionProof(userId, gymId, accessToken);
  try {
    const result = await operation();
    if (result?.status === 401) throw rejectSession(userId, gymId, proof);
    return result;
  } catch (err) {
    if (err?.status === 401 && err.code !== 'GYM_SESSION_EXPIRED') throw rejectSession(userId, gymId, proof);
    throw err;
  }
}
let delivering = null;
function deliverPending() {
  if (delivering) return delivering;
  delivering = (async () => {
    const handle = db().db;
    const rows = handle.prepare(`SELECT n.* FROM gym_login_notifications n JOIN user_gyms ug
      ON ug.user_id=n.user_id AND ug.gym_id=n.gym_id AND ug.login_incident=n.incident
      WHERE n.delivered_at IS NULL AND (n.attempted_at IS NULL OR n.attempted_at < ?)`).all(new Date(Date.now()-300000).toISOString());
    for (const row of rows) {
      handle.prepare('UPDATE gym_login_notifications SET attempted_at = ? WHERE incident = ?').run(new Date().toISOString(), row.incident);
      try {
        await require('./notifications').notify(row.user_id, 'gymLoginRequired', {
          gymId: row.gym_id, incident: row.incident, url: `/?reconnect=${encodeURIComponent(row.gym_id)}`,
        });
        handle.prepare('UPDATE gym_login_notifications SET delivered_at = ? WHERE incident = ?').run(new Date().toISOString(), row.incident);
      } catch (_) { /* persistent incident remains; retry on the existing background cycle */ }
    }
  })().finally(() => { delivering = null; });
  return delivering;
}
module.exports = { withRecovery, unavailable, expiredError, requireLogin, deliverPending, sessionProof, rejectSession, retrySessionCall };
