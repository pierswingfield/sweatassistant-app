// Signing secrets (security audit part 2). One root secret, domain-separated
// derivations, so no new env var is required:
//   * user session JWTs  -> the root secret itself (unchanged: live tokens keep verifying)
//   * admin session JWTs -> HMAC-SHA256(root, 'dibs:admin-jwt:v1'), so a user token can
//     never be (or be replayed as) an admin token and vice versa
// Root: JWT_SECRET from the environment WINS; only if absent is one generated and kept in
// server_kv.jwt_secret. Production should set JWT_SECRET: otherwise the secret lives in
// the same SQLite file (and the same off-host backups) as the data it protects.
const crypto = require('crypto');
const db = require('./db');

let root = null;
function rootSecret() {
  if (root) return root;
  root = process.env.JWT_SECRET;
  if (!root) {
    root = db.getKV('jwt_secret');
    if (!root) {
      root = crypto.randomBytes(32).toString('hex');
      db.setKV('jwt_secret', root);
    }
  }
  return root;
}

const derive = (label) => crypto.createHmac('sha256', rootSecret()).update(label).digest('hex');

module.exports = {
  userJwtSecret: () => rootSecret(),
  adminJwtSecret: () => derive('dibs:admin-jwt:v1'),
};
