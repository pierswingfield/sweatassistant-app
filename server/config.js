// Central configuration — values come from env vars with defaults matching the
// original hardcoded values. This is the single server-side source of truth for
// the app name and public host. All server modules that need these values should
// import from here rather than reading process.env directly.
const publicHost = process.env.PUBLIC_HOST || 'psycle.wingfield.tech';

// Allowed browser origins for CORS. In production the PWA is served same-origin
// from this server, so the allowlist only needs the public host (http + https).
// A comma-separated CORS_ORIGINS env var overrides the default list. Localhost
// dev origins are added separately in server.js when NODE_ENV !== 'production'.
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [`https://${publicHost}`, `http://${publicHost}`];

module.exports = {
  appName: process.env.APP_NAME || 'Psycle Assistant',
  publicHost,
  corsOrigins,
};
