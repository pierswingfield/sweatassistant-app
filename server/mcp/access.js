// Product eligibility defaults to on. Deployment flags, OAuth consent and gym
// ownership remain independent gates; an override never expands a grant.
const db = require('../db');
function accountEnabled(userId) {
  return !!db.db.prepare(`SELECT 1 FROM users u LEFT JOIN mcp_account_access a ON a.user_id=u.id
    WHERE u.id=? AND COALESCE(a.enabled,1)=1`).get(userId);
}
function gymEnabled(gymId) {
  return !!db.db.prepare(`SELECT 1 FROM gyms g LEFT JOIN mcp_gym_access a ON a.gym_id=g.id
    WHERE g.id=? AND g.enabled=1 AND COALESCE(a.enabled,1)=1`).get(gymId);
}
function setAccount(userId, enabled) {
  return db.db.transaction(() => {
    db.db.prepare(`INSERT INTO mcp_account_access(user_id,enabled) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled`).run(userId, Number(enabled));
    bump('account', userId);
  })();
}
function setGym(gymId, enabled) {
  return db.db.transaction(() => {
    db.db.prepare(`INSERT INTO mcp_gym_access(gym_id,enabled) VALUES (?,?)
    ON CONFLICT(gym_id) DO UPDATE SET enabled=excluded.enabled`).run(gymId, Number(enabled));
    bump('gym', gymId);
  })();
}
function bump(kind, target) {
  db.db.prepare(`INSERT INTO mcp_policy_versions(kind,target) VALUES (?,?)
    ON CONFLICT(kind,target) DO UPDATE SET revision=revision+1`).run(kind, String(target));
}
function writePreference(userId) {
  const row = db.db.prepare('SELECT enabled,revision FROM mcp_write_preferences WHERE user_id=?').get(userId);
  return { enabled: row?.enabled === 1, revision: row?.revision || 0 };
}
function setWritePreference(userId, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('Write preference must be boolean');
  db.db.prepare(`INSERT INTO mcp_write_preferences(user_id,enabled) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,revision=revision+1`).run(userId, Number(enabled));
}
function policyVersion(kind, target) {
  return db.db.prepare('SELECT revision FROM mcp_policy_versions WHERE kind=? AND target=?').get(kind, String(target))?.revision || 0;
}
module.exports = { accountEnabled, gymEnabled, setAccount, setGym, writePreference, setWritePreference, policyVersion };
