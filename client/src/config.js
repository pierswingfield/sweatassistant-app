import { appName, publicHost } from '../../app.config.json';

// Build-time defaults (from app.config.json). Overridden at runtime by /api/config
// so the same built client can serve under a different app name / domain without
// a rebuild (server-side template replace handles static HTML; this handles
// JS-rendered text like onboarding, toasts, and dynamic titles).
export const appConfig = {
  appName,
  publicHost,
};

let initialized = false;

// Fetch runtime config from the server. Call once early in the startup flow
// (before any UI renders). Subsequent calls are no-ops. Fails gracefully — if
// the server is unreachable, build-time defaults remain in place.
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
  } catch (_) { /* use build-time defaults */ }
}
