# Personal statistics and setup refinements — implementation status

2026-11-08: Implemented locally against [the approved brief](HOME-PERSONAL-STATS-ONBOARDING-2026-11-08.md). No deployment, commit, push, host access or infrastructure change.

Private history aggregates and chart rail replace Home provider-total tiles; provider attendance APIs remain available for gym settings. Weekly streak, 30-day volume and 90-day habit distributions use all stored linked history with explicit sync coverage. Completed the requested onboarding copy, linear repeating studio marquee with accessible pause, saved-slot Auto-Upgrade guard, date-row right-fade exemption, Teams skeleton/two-row pitch, About mascot/privacy refinement and saved-favourites visibility/finder copy.

Evidence and limitations: [local implementation receipt](../QA/browser-runs/personal-stats-implementation-2026-11-08/README.md), with exact diff, real Chrome before/after screenshots and machine-readable state/animation results. Node 22.23.4: 122/122 server suites passed; after updating obsolete client expectations, 122 client files / 981 tests passed. Client build passed with existing chunk-size warning; diff check clean. Privacy account-scope mutation was caught and restored.

Review URL: http://localhost:5174/ (isolated fixture server on 3001). Existing 3000/5173 services and all existing user tabs/artifacts preserved. Physical iOS/Android and live provider completeness remain unverified. Production is unchanged; release requires a fresh explicit instruction for an environment.
