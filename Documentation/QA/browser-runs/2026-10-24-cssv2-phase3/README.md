# CSSv2 Phase 3 after-screenshots (2026-10-24)

- `chrome-extension/`: Claude for Chrome, 390px same-origin iframe (light) plus one 955px desktop capture, dev mock, worktree `App-CSSv2` build. Measured there: scrollWidth equals clientWidth at 375/390/430 on Home, Timetable, Bookings, Auto-Book, Settings; booking modal is 390x844 (full-screen page); Status column computed width 112px on desktop.
- `headless-after/`: scripted headless Chromium after-captures (390 light+dark, 1200 desktop), same mock data as the baseline run.
- Equivalence evidence is the computed-style diff of 132 rendered states against the Phase 2 stylesheet (see `Documentation/Audits/cssv2-baseline.md` section 6).
