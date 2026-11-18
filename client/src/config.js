// The instance config (app name, public host) has ONE source: the server's
// config.js (APP_NAME / PUBLIC_HOST). The server templates the app name into
// index.html before sending it, so document.title is already correct at first
// paint; /api/config then supplies the same values to JS-rendered text
// (onboarding, toasts, dynamic titles). No name is baked into the bundle.
//
// The name is read from <meta name="application-name">, NEVER document.title: the
// Teams invite route (/t/:token) rewrites <title> to "You've been invited to a Team
// on <app>", which leaked into every string built from the app name ("...on Dibs
// won't save copies of your gym login details").
export function readTemplatedAppName(doc = typeof document !== 'undefined' ? document : null) {
  const name = doc?.querySelector?.('meta[name="application-name"]')?.getAttribute('content') || '';
  return name && name !== '__APP_NAME__' ? name : '';
}
export const appConfig = {
  appName: readTemplatedAppName(),
  publicHost: '',
  turnstileSiteKey: '',
};

let initialized = false;

// Fetch runtime config from the server. Call once early in the startup flow
// (before any UI renders). Subsequent calls are no-ops. Fails gracefully — if
// the server is unreachable, the templated document title stays in place.
export async function initConfig() {
  if (initialized) return;
  initialized = true;
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data.appName) appConfig.appName = data.appName;
      if (data.publicHost) appConfig.publicHost = data.publicHost;
      if (data.turnstileSiteKey) appConfig.turnstileSiteKey = data.turnstileSiteKey;
    }
  } catch (_) { /* keep the templated defaults */ }
}
