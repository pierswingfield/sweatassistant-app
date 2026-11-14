# Home attendance widget restoration — 2026-11-12

Before: Chrome 156 via the user's CDP session, local mock Psycle account at `/home`. The registered widgets included the charts (`stats`, order 70), credits (60), and no attendance-count widget; no-Team card was order 1000. Desktop rendered credits in the right column. Screenshot: [before](../QA/browser-runs/home-attendance-2026-11-12/before.png). The prior attendance widget was replaced by the charts registration in commit `46cd27c`; its supporting count and rendering functions remain in `home.js`.

After: the original attendance widget registration is restored as `attendance` immediately after the charts (`stats`), preserving the prior all-linked-gym count and partial-coverage behavior. Credits now sort after the no-Team card as the final widget, including in the desktop tail.

Chrome CDP, same local mock account, after unregistering service workers, clearing CacheStorage and IndexedDB, and reloading: desktop DOM showed `stats` 70 then `attendance` 71 with `129 classes`; the tail had `teams` 1000 then `credits` 1001. At a 390 × 844 emulated viewport, the same adjacency and final credits placement were observed. Screenshots: [desktop](../QA/browser-runs/home-attendance-2026-11-12/after-desktop.png), [mobile](../QA/browser-runs/home-attendance-2026-11-12/after-mobile.png). Mock data only; this is not a live gym API check.

Focused check: `npm run test:client -- --run src/ui/home.test.js` with Node 22.23.4: **1 test file passed, 46 tests passed**. Before the restoration, the new placement test failed because `attendance` was absent (1 failed, 45 passed). Full-suite and build verification are coordinated separately for the combined changes.
