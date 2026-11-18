// The ONLY reader/writer of `account_email_tokens`: one-time links sent by email
// (purpose 'verify' now; 'reset' and 'email_change' reuse it later).
//
// Rules: 128+ bits of randomness, valid 30 minutes, single use. Only the SHA-256 of a
// token is stored (same pattern as Teams invites), so a database copy or backup holds
// nothing that can be clicked. Issuing a token supersedes every older unused token of
// the same purpose for that user. Callers never log the raw token or a link built from it.
const crypto = require('crypto');
const db = require('./db').db;

const PURPOSES = new Set(['verify', 'reset', 'email_change', 'not_me']);
const TTL_MS = 30 * 60 * 1000;
// "I did not create this account" links outlive the 30 minutes: people read the mail days later.
const NOT_ME_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ttlFor = (purpose) => (purpose === 'not_me' ? NOT_ME_TTL_MS : TTL_MS);

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Mint a token. Returns { token, id, expiresAt }; `token` is shown once (put it in the mail). */
function issue(userId, purpose, { newEmail = null, now = Date.now() } = {}) {
  if (!PURPOSES.has(purpose)) throw new Error('Unknown token purpose');
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = now + ttlFor(purpose);
  const id = db.transaction(() => {
    // Supersede (not delete): created_at history must survive for countRecent().
    // not_me links are NOT superseded: the signup mail and the notice are separate mails and both must keep working.
    if (purpose !== 'not_me') db.prepare('UPDATE account_email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(now, userId, purpose);
    return db.prepare('INSERT INTO account_email_tokens (user_id, purpose, token_hash, new_email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, purpose, hash(token), newEmail, expiresAt, now).lastInsertRowid;
  })();
  return { token, id: Number(id), expiresAt };
}

/**
 * Consume a token atomically: succeeds once, only for the right purpose, only before expiry.
 * Returns { userId, newEmail } or null for anything else (unknown, wrong purpose, used, expired).
 */
function consume(token, purpose, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const row = db.prepare(`UPDATE account_email_tokens SET used_at = ?
    WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
    RETURNING user_id, new_email`).get(now, hash(token), purpose, now);
  return row ? { userId: row.user_id, newEmail: row.new_email } : null;
}

/** Look at a live token WITHOUT consuming it (landing-page preview). Returns { userId, newEmail } or null. */
function peek(token, purpose, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const row = db.prepare('SELECT user_id, new_email FROM account_email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?')
    .get(hash(token), purpose, now);
  return row ? { userId: row.user_id, newEmail: row.new_email } : null;
}

/** The user's live, unexpired change-of-address request, if any: { newEmail, expiresAt }. */
function pendingEmailChange(userId, { now = Date.now() } = {}) {
  const row = db.prepare(`SELECT new_email, expires_at FROM account_email_tokens WHERE user_id = ? AND purpose = 'email_change'
    AND used_at IS NULL AND expires_at > ? AND new_email IS NOT NULL AND new_email <> '' ORDER BY id DESC LIMIT 1`).get(userId, now);
  return row ? { newEmail: row.new_email, expiresAt: row.expires_at } : null;
}

/** Invalidate every live token of this purpose for the user (cancel a pending change). Returns how many. */
function cancel(userId, purpose, { now = Date.now() } = {}) {
  return db.prepare('UPDATE account_email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(now, userId, purpose).changes;
}

/** Tokens of this purpose minted for the user since `sinceMs` (consumed or superseded ones included). */
function countRecent(userId, purpose, sinceMs) {
  return db.prepare('SELECT COUNT(*) AS n FROM account_email_tokens WHERE user_id = ? AND purpose = ? AND created_at >= ?').get(userId, purpose, sinceMs).n;
}

/**
 * Count an attempt that minted no live token (wrong password, taken address) so the per-account
 * limit sees it. The row is born used and expired, so consume() can never match it; its hash is
 * random and its new_email is the empty string.
 */
function recordAttempt(userId, purpose, { now = Date.now() } = {}) {
  if (!PURPOSES.has(purpose)) throw new Error('Unknown token purpose');
  db.prepare('INSERT INTO account_email_tokens (user_id, purpose, token_hash, new_email, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, purpose, hash(crypto.randomBytes(32).toString('base64url')), '', now, now, now);
}

/** Housekeeping: drop rows that expired more than a day ago. */
function purgeExpired(now = Date.now()) {
  return db.prepare('DELETE FROM account_email_tokens WHERE expires_at < ?').run(now - 24 * 60 * 60 * 1000).changes;
}

module.exports = { issue, consume, peek, pendingEmailChange, cancel, NOT_ME_TTL_MS, countRecent, recordAttempt, purgeExpired, TTL_MS };
