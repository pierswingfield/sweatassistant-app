# Today sizing — 2026-11-07

User request: smaller gym logo, larger time; promote current Teams release to production.

Baseline in real user Chrome: completed logos 30px, upcoming declaration 44px, time 12px. Change only Today's workouts: consistent 28px logos, time 14px, proportional 16px completion badge. Week styles untouched.

Real Chrome CDP own tab, cache-cleared local mock app:
- 320px: all logos 28px; all times 14px; completed/upcoming ET time boxes x=67, width=40; no overlap or horizontal overflow.
- 390px light and dark and 1280px desktop: same logo/time dimensions, no overlap or overflow.
- Completed collapse remains 44px, disclosure false→true→false.
- New York completed/upcoming cases are browser-only rendering fixtures, never database records.

Checks output: `120/120 server suites passed`; `117 passed` client files, `959 passed` tests. Final build `built in 874ms`; existing import/chunk-size warnings. `git diff --check` no output / exit 0.

Physical iOS remains unverified.

Production released source `b50bf6d09fcd71f3af8993829e99daf2cf41ed10`; existing authenticated session renders Teams empty state (`prod-teams-390.png`), authenticated GET /api/teams HTTP 200. Public/internal health 200, all three services healthy, restart count 0, ARM64 Node22.23.4. Current production has zero Teams; Today rendering validated locally. Exact release receipt in PROGRESS-teams.md.
