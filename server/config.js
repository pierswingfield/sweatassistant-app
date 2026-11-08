// Central configuration — values come from env vars. This is the single
// server-side source of truth for the app name, public host and VAPID contact.
// All server modules that need these values should import from here rather than
// reading process.env directly.
//
// PUBLIC_HOST and VAPID_EMAIL identify the DEPLOYMENT (calendar feed URLs, push
// contact), so no default is correct for production and none is invented: with
// NODE_ENV=production the server refuses to start without them. Outside
// production (dev, tests) they fall back to inert localhost values.
const isProduction = process.env.NODE_ENV === 'production';

function requiredInProduction(name, devDefault) {
  const value = (process.env[name] || '').trim();
  if (value) return value;
  if (isProduction) {
    throw new Error(`[Config] ${name} is required when NODE_ENV=production. Set it in the service's .env (see .env.example).`);
  }
  return devDefault;
}

const publicHost = requiredInProduction('PUBLIC_HOST', 'localhost');
// Pin this once per deployed database. Feed URLs can move; VEVENT identities must not.
const calendarUidNamespace = (process.env.CALENDAR_UID_NAMESPACE || publicHost).trim();
if (process.env.CALENDAR_UID_NAMESPACE && !/^[a-zA-Z0-9.-]+$/.test(calendarUidNamespace)) {
  throw new Error('[Config] CALENDAR_UID_NAMESPACE must be a hostname-shaped stable identifier.');
}
const vapidEmail = requiredInProduction('VAPID_EMAIL', 'mailto:admin@localhost.invalid');
if (!/^(mailto:|https:\/\/)/.test(vapidEmail)) {
  throw new Error('[Config] VAPID_EMAIL must be a mailto: address or an https:// URL.');
}

// Allowed browser origins for CORS. In production the PWA is served same-origin
// from this server, so the allowlist only needs the public host (http + https).
// A comma-separated CORS_ORIGINS env var overrides the default list. Localhost
// dev origins are added separately in server.js when NODE_ENV !== 'production'.
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [`https://${publicHost}`, `http://${publicHost}`];

// Express `trust proxy`: how many reverse-proxy hops in front of the app to
// believe. Production sits behind exactly one (the Cloudflare Tunnel's
// cloudflared, reaching sweatassistant:3000 over the `edge` network; Cloudflare
// appends the real client IP to X-Forwarded-For). Trusting exactly 1 hop makes
// req.ip the last X-Forwarded-For entry, which a client cannot forge. NEVER
// `true` (trusts the whole header, so any client can mint a fresh rate-limit
// bucket per request). Dev/tests default to 0 (no proxy). Override with
// TRUST_PROXY=<hops>; set 0 if the app is ever exposed without the tunnel.
function parseTrustProxy(raw) {
  if (raw === undefined || String(raw).trim() === '') return isProduction ? 1 : 0;
  const v = String(raw).trim().toLowerCase();
  if (v === 'false') return 0;
  if (/^\d+$/.test(v)) return Number(v);
  throw new Error('[Config] TRUST_PROXY must be a non-negative hop count (e.g. 1) or "false"; "true" and subnet lists are refused.');
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

// HSTS (security audit): production only, modest max-age, no includeSubDomains
// and no preload (Cloudflare may also set it at the edge). HSTS_MAX_AGE=0 turns
// it off. CSP_REPORT_ONLY=1 downgrades the Content-Security-Policy to
// Report-Only, an escape hatch if a deploy hits an unforeseen violation.
const hstsMaxAge = process.env.HSTS_MAX_AGE !== undefined && /^\d+$/.test(String(process.env.HSTS_MAX_AGE).trim())
  ? Number(String(process.env.HSTS_MAX_AGE).trim())
  : 15552000; // 180 days
const hsts = isProduction && hstsMaxAge > 0 ? `max-age=${hstsMaxAge}` : null;
const cspReportOnly = /^(1|true|yes)$/i.test(String(process.env.CSP_REPORT_ONLY || '').trim());

// Where /_a/go sends the landing-page CTA. Fixed here, never taken from request input.
const landingCtaTarget = 'https://app.dibs.fit';

module.exports = {
  landingCtaTarget,
  appName: process.env.APP_NAME || 'Dibs',
  publicHost,
  calendarUidNamespace,
  vapidEmail,
  corsOrigins,
  trustProxy,
  hsts,
  cspReportOnly,
};
