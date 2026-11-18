// Cloudflare Turnstile (bot check for the unauthenticated /not-me flow).
//
// Site key (public, goes to the page via /api/config): TURNSTILE_SITE_KEY.
// Secret (server only, never logged): TURNSTILE_SECRET_KEY, verified against siteverify with the
// client IP and a 5 s timeout. Outside production, with no secret, Cloudflare's documented
// always-pass TEST pair is used so dev works; in production a missing secret means the feature is
// unavailable (callers answer 503). Env is read at call time so tests can flip it.
const config = require('./config');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;
const ACTION = 'not_me';
const TEST_SITE_KEY = '1x00000000000000000000AA';   // Cloudflare dummy: always passes (visible widget)
const TEST_SECRET = '1x0000000000000000000000000000000AA'; // Cloudflare dummy: always passes

let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

const isProd = () => process.env.NODE_ENV === 'production';
const env = (k) => (process.env[k] || '').trim();

/** The secret to verify with, or null when the feature is unavailable (production without one). */
function secret() {
  if (env('TURNSTILE_SECRET_KEY')) return env('TURNSTILE_SECRET_KEY');
  return isProd() ? null : TEST_SECRET;
}
const usingTestSecret = () => !env('TURNSTILE_SECRET_KEY') && !isProd();
const available = () => !!secret() && (!!env('TURNSTILE_SITE_KEY') || !isProd());

/** Public site key for the page, or null when the feature is unavailable. */
function siteKey() {
  if (!available()) return null;
  return env('TURNSTILE_SITE_KEY') || TEST_SITE_KEY;
}

/** Resolves { ok: true } | { ok: false, reason: 'failed' | 'unavailable' }. Never throws. */
async function verify(token, remoteIp) {
  const key = secret();
  if (!key) return { ok: false, reason: 'unavailable' };
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, reason: 'failed' };
  try {
    const form = new URLSearchParams({ secret: key, response: token });
    if (remoteIp) form.set('remoteip', String(remoteIp));
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const data = await res.json();
    if (!data || data.success !== true) return { ok: false, reason: 'failed' };
    if (!usingTestSecret()) {
      if (data.action && data.action !== ACTION) return { ok: false, reason: 'failed' };
      if (isProd() && data.hostname && data.hostname !== config.publicHost) return { ok: false, reason: 'failed' };
    }
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'unavailable' };
  }
}

module.exports = { verify, siteKey, available, setFetchForTests, ACTION, TEST_SITE_KEY, TEST_SECRET };
