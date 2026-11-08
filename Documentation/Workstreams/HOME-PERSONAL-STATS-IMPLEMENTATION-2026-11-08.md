# Personal statistics and setup refinements — implementation status

2026-11-08: Implemented locally against [the approved brief](HOME-PERSONAL-STATS-ONBOARDING-2026-11-08.md). No deployment, commit, push, host access or infrastructure change.

Private history aggregates and chart rail replace Home provider-total tiles; provider attendance APIs remain available for gym settings. Weekly streak, 30-day volume and 90-day habit distributions use all stored linked history with explicit sync coverage. Completed the requested onboarding copy, linear repeating studio marquee with accessible pause, saved-slot Auto-Upgrade guard, date-row right-fade exemption, Teams skeleton/two-row pitch, About mascot/privacy refinement and saved-favourites visibility/finder copy.

Evidence and limitations: [local implementation receipt](../QA/browser-runs/personal-stats-implementation-2026-11-08/README.md), with exact diff, real Chrome before/after screenshots and machine-readable state/animation results. Node 22.23.4: 122/122 server suites passed; after updating obsolete client expectations, 122 client files / 981 tests passed. Client build passed with existing chunk-size warning; diff check clean. Privacy account-scope mutation was caught and restored.

Review URL: http://localhost:5174/ (isolated fixture server on 3001). Existing 3000/5173 services and all existing user tabs/artifacts preserved. Physical iOS/Android and live provider completeness remain unverified. Production is unchanged; release requires a fresh explicit instruction for an environment.

## Dev release authorized and verified

2026-11-08: user explicitly requested push to dev. Source `46cd27c223853c9130be853c978f2bb004694a42` committed/pushed to `origin/teams` and deployed from an immutable runtime-only archive to `sweatassistant-dev`. [Release receipt](../QA/browser-runs/personal-stats-dev-release-2026-11-08/README.md) records Docker/health, served-hash, database/config preservation and real Chrome welcome evidence. Production/experiment unchanged. App account is signed out in dev Chrome; authenticated chart acceptance remains the local fixture evidence above.
