// Central configuration — values come from env vars with defaults matching the
// original hardcoded values. This is the single server-side source of truth for
// the app name and public host. All server modules that need these values should
// import from here rather than reading process.env directly.
module.exports = {
  appName: process.env.APP_NAME || 'Psycle Assistant',
  publicHost: process.env.PUBLIC_HOST || 'psycle.wingfield.tech',
};
