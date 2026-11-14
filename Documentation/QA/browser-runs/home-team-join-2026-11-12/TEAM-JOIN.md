# Team invitation continuation — 2026-11-12

Verified locally in the user's Google Chrome 156 via CDP9222. No deployment or live-gym writes occurred. One shared QA tab was reused with the Home task. CacheStorage, IndexedDB and service-worker data were cleared before each entry scenario.

The original loop (`node /tmp/team-repro.cjs`) recorded an authenticated, gym-less account visiting an invite with onboarding `step: intro`, visible `flex`. A fresh signed-out invite displayed no Team identity. Source inspection confirmed `checkAuth()` chose gym onboarding before the Teams route and the onboarding login resolver always continued setup. Name capture also always rendered even when both account names were saved. The fix gives existing account invite intent precedence, lets returning login finish at the invite without recording setup completion, and retains an account-specific signup marker so a newly created account resumes setup across reloads.

Public preview returns only the name and emoji. Signing up never creates Team membership or sends a request. The existing invitation welcome and explicit sharing/send-request steps remain responsible for consent.

The install manifest has the app's existing stable `id` and `scope` (`/`) with a per-install opaque start URL. A hashed server record expires after 24 hours and is consumed atomically on first handoff. An already-used, expired, malformed or revoked continuation becomes an ordinary launch. The browser invalidates its handoff when it reaches the invitation itself; a later install cannot revive that completed browser intent. HTTP/network failures preserve the launch URL for retry. An old used launch token does not erase another currently pending invitation.

## Repeatable browser check

Start the local fixture server on 3000 and Vite on 5173, then point the script at the one shared Chrome QA tab:

```bash
TAB_ID=<qa-tab-id> node Documentation/QA/browser-runs/home-team-join-2026-11-12/team-join-cdp.cjs
```

Observed output:

```text
PASS existing logged-in account skips all setup and reaches invitation welcome
PASS signed-out first screen previews Team and prepares opaque install manifest
PASS returning login goes straight to welcome and invalidates browser install handoff
PASS new signup completes resumable onboarding before invitation welcome
PASS opening welcome and completing onboarding never requests membership
PASS fresh storage restores Team once; replay silently opens ordinary app
PASS returning account with saved first and last name skips name capture
7/7 Team join browser checks passed
```

Screens: `team-authenticated-welcome.png`, `team-signed-out-preview.png`, `team-new-signup-setup.png`, `team-new-signup-welcome.png`, `team-fresh-storage-continuation.png`, `existing-account-name-skipped.png`. Machine-readable summary: `team-join-results.json`.

Supporting checks:

```text
client focused routing/name/install-storage suites: 4 files, 60 tests passed
server/test-team-install-continuation.js: 7/7 checks passed
server/test-team-membership.js: 24 checks passed
```

Physical iPhone Add to Home Screen was not tested. Fresh storage was simulated by clearing the real Chrome tab's browser storage before navigating to the manifest start URL. This verifies server persistence, routing, single use and consent behavior, but does not prove that a particular iOS/browser version captures a dynamically updated manifest during installation.
