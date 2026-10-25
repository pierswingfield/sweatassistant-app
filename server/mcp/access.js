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
  db.db.prepare(`INSERT INTO mcp_account_access(user_id,enabled) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled`).run(userId, Number(enabled));
}
function setGym(gymId, enabled) {
  db.db.prepare(`INSERT INTO mcp_gym_access(gym_id,enabled) VALUES (?,?)
    ON CONFLICT(gym_id) DO UPDATE SET enabled=excluded.enabled`).run(gymId, Number(enabled));
}
module.exports = { accountEnabled, gymEnabled, setAccount, setGym };
