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

module.exports = {
  encrypt,
  decrypt
};
