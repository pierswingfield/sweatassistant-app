# Home supporting copy and class names — 9 November 2026

## Verified basis before changes

Real Google Chrome through CDP reproduced all four exact supporting paragraphs (isolated local empty-state fixture and live experiment Home). At 320px the Find a class invitation was **17px / 500**, personal statistics and trending instructor empty copy **14px / 400**, and Teams **13px / 400**. The invitation explicitly used emphasis and balanced wrapping; generic empty paragraphs lacked an explicit size. DESIGN.md §4 specifies compact secondary body as Inter 13px, regular, line-height 1.4. Shared scoped supporting typography will align these without changing headings or actions. Before screenshots and measurements: `before-*-*.png`, `before-local-checks.json`. Red-capable browser check: 5/10 pass before changes; four hierarchy checks and prefix cleanup fail.

Read-only experiment `GET /api/events/221582` returned HTTP 200 with title **LAGREE | Lagree & Free Shake (Signature 50)** and discipline **Lagree**. Both linked gyms were healthy at this inspection, superseding earlier needs-login evidence. `event221582-capture.json` retains only public class fields; no credentials. Existing display cleaning removes `LAGREE` plus whitespace and leaves the pipe. The client cleaner is used by timetable, Home favourites, bookings, Auto-Book/Upgrade and overlap displays; its server mirror composes calendar, scheduler/poller and competing-booking text. Fix this display seam, retaining original provider data.

The targeted client regression ran red: **2 failed / 11 passed** (`parser-red.txt`), including the exact supplied event title and leading punctuation preservation. Planned cleanup is deliberately limited to vertical pipes (ASCII/fullwidth) and spaced decorative dash/colon/bullet prefixes. Meaningful hashtags, quotes, parentheses, unspaced hyphens and internal separators remain intact. Existing discipline and case rules remain covered.

## Final verification and Your Stats empty-copy removal

- Removed `"Your training story starts with your first past class."` (`COPY.home.statsEmptyHistory`) from the `Your stats` widget when `totalPastClasses === 0`; the `0 weeks` streak tile renders cleanly without a redundant empty paragraph below it.
- Shared compact body rule (`13px / 1.4`, `--text-secondary`) aligns Home supporting paragraphs (`.home-book-invitation`, `.home-widget-empty`, `.home-teams-empty p`).
- `cleanClassNameWith` in `client/src/class-name.js` and `server/class-name.js` trims decorative leading pipes and spaced separators before and after discipline stripping (`LAGREE | Lagree & Free Shake (Signature 50)` -> `Lagree & Free Shake (Signature 50)`).
- Full test suite: **125/125 server suites** and **998/998 client tests across 124 files** pass, production client build passes, and **10/10 real-Chrome checks** (`after-local-checks.json`, `after-*-*.png`) pass across 320px/390px/1280px light and dark.
