#!/usr/bin/env node
// Local operator controls, using the service's DB_PATH. Never emits credentials.
const store = require('./store');
const [action, user, grant] = process.argv.slice(2);
const userId = Number(user);
if (!Number.isSafeInteger(userId) || userId < 1 || !['list', 'revoke', 'revoke-all'].includes(action) || (action === 'revoke' && !grant)) {
  console.error('Usage: node server/mcp/manage.js list|revoke|revoke-all USER_ID [GRANT_ID]');
  process.exitCode = 1;
} else if (action === 'list') {
  console.log(JSON.stringify(store.listGrants(userId), null, 2));
} else {
  console.log(JSON.stringify({ revoked: action === 'revoke' ? store.revokeGrant(userId, grant) : store.revokeAll(userId) }));
}
