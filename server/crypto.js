const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// ENCRYPTION_KEY must be set in the environment (e.g. via .env or docker secret).
// The old DB-stored fallback has been removed: storing the key next to the ciphertext
// in the same SQLite file defeats the purpose of encryption entirely.
//
// Migration: if you were running without ENCRYPTION_KEY previously, the server was
// using an auto-generated key stored in the server_kv table. To migrate:
//   1. Run: sqlite3 <db> "SELECT value FROM server_kv WHERE key='server_encryption_key';"
//   2. Add ENCRYPTION_KEY=<that value> to your .env before deploying.
const ENCRYPTION_KEY_RAW = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY_RAW) {
  console.error('[crypto] FATAL: ENCRYPTION_KEY environment variable is required but not set. Refusing to start.');
  process.exit(1);
}

// Security audit part 2: the key must be a real 32-byte secret, not a short or
// guessable string. Accepted encodings: 64 hex chars (`openssl rand -hex 32`),
// base64 that decodes to 32 bytes (`openssl rand -base64 32`), or a raw 32-byte
// string. The AES key is still sha256(raw string) — NOT the decoded bytes — so
// every ciphertext already in a live DB keeps decrypting. This only refuses weak keys.
function decodedKeyLength(raw) {
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) return raw.length / 2;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) return Buffer.from(raw, 'base64').length;
  return Buffer.byteLength(raw, 'utf8');
}
function keyLengthOk(raw) {
  if (decodedKeyLength(raw) === 32) return true;
  return Buffer.byteLength(raw, 'utf8') === 32; // raw 32-byte string that happens to look like hex/base64
}
if (!keyLengthOk(ENCRYPTION_KEY_RAW)) {
  console.error(`[crypto] FATAL: ENCRYPTION_KEY must decode to exactly 32 bytes (64 hex chars, or 32-byte base64, or a 32-byte string); got ${decodedKeyLength(ENCRYPTION_KEY_RAW)} bytes. Generate one with: openssl rand -hex 32. Refusing to start.`);
  process.exit(1);
}

function getEncryptionKey() {
  // SHA-256 of the raw key → guaranteed 32-byte AES key regardless of input length/format
  return crypto.createHash('sha256').update(ENCRYPTION_KEY_RAW).digest();
}

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Return format: iv:authTag:encryptedText
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(encryptedString) {
  if (!encryptedString) return null;
  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = Buffer.from(parts[2], 'hex');
  
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

// --- Versioned format with AAD (security audit part 2) -----------------------
// `s2:<iv>:<tag>:<ct>` (hex). Used for user_gyms.session_json. The AAD binds the
// ciphertext to its purpose, so a stored password ciphertext (legacy format, no
// AAD) can never be replayed into the session column or vice versa. The legacy
// format above is untouched: adding AAD to it would break every live ciphertext.
const V2_PREFIX = 's2:';
function encryptV2(text, aad) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `${V2_PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ct.toString('hex')}`;
}
function isV2(value) { return typeof value === 'string' && value.startsWith(V2_PREFIX); }
function decryptV2(value, aad) {
  const parts = String(value).slice(V2_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), Buffer.from(parts[0], 'hex'));
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString('utf8');
}

module.exports = {
  encrypt,
  decrypt,
  encryptV2,
  decryptV2,
  isV2,
  V2_PREFIX,
};
