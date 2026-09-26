// C1-1: the event debug modal (timetable.js `openDebugModal`) JSON.stringifies
// raw provider payloads (event/booking/waitlist `.raw`) with HTML-escaping only
// — no redaction. A gym's raw payload is not a contract this app controls (see
// AGENTS.md "no gym is privileged above the adapter layer"), so rather than
// trust that today's shape has nothing sensitive in it, this pass blocks known
// -sensitive KEY NAMES generically, on any object depth, before the payload
// ever reaches JSON.stringify.
//
// Deliberately narrow: only the categories QA-22 named (tokens, keys,
// passwords, emails, payment fields). A broader net (e.g. "session", "cookie")
// would also catch legitimate raw fields like MarianaTek's `class_session_type`
// and make the debug view useless for its actual job.

const SENSITIVE_KEY_TOKENS = new Set([
  // tokens / auth
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'jwt', 'bearer', 'authorization',
  // keys / secrets
  'key', 'apikey', 'secretkey', 'privatekey', 'secret', 'clientsecret',
  // passwords
  'password', 'passwd', 'pass', 'pwd',
  // emails
  'email', 'emailaddress',
  // payment fields
  'card', 'cardnumber', 'cardnum', 'cvv', 'cvc', 'pan', 'iban', 'ssn',
  'accountnumber', 'sortcode', 'routingnumber', 'last4', 'expmonth', 'expyear',
  'billingaddress',
]);

// Splits a key like `access_token`, `accessToken` or `Access-Token` into
// lowercase tokens: ['access', 'token'].
function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function isSensitiveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  const tokens = keyTokens(key);
  // Whole-key match too (covers single-word keys tokenizing wouldn't split,
  // e.g. a raw field simply called `email`).
  return tokens.some((t) => SENSITIVE_KEY_TOKENS.has(t));
}

/**
 * Deep-clones `value`, replacing the VALUE of any object key that looks
 * sensitive with `'[redacted]'`. Arrays and non-sensitive nested objects are
 * walked recursively. Pure function — no DOM, no I/O — so it's unit-testable
 * in isolation from the modal that calls it.
 */
export function redactSensitivePayload(value, seen = new WeakSet()) {
  if (Array.isArray(value)) {
    return value.map((v) => redactSensitivePayload(v, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = val == null ? val : '[redacted]';
      } else {
        out[key] = redactSensitivePayload(val, seen);
      }
    }
    return out;
  }
  return value;
}
