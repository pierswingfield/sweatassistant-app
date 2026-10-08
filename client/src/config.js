// The instance config (app name, public host) has ONE source: the server's
// config.js (APP_NAME / PUBLIC_HOST). The server templates the app name into
// index.html before sending it, so document.title is already correct at first
// paint; /api/config then supplies the same values to JS-rendered text
// (onboarding, toasts, dynamic titles). No name is baked into the bundle.
const templated = typeof document !== 'undefined' ? document.title : '';
export const appConfig = {
  appName: templated && templated !== '__APP_NAME__' ? templated : '',
  publicHost: '',
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
    }
  } catch (_) { /* keep the templated defaults */ }
}
