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

module.exports = {
  appName: process.env.APP_NAME || 'Sweat Assistant',
  publicHost,
  vapidEmail,
  corsOrigins,
};
