# Personal stats: Team presentation reuse

2026-11-08. Authenticated dev Chrome baseline: Home displayed a loose streak, visible daily-count disclosure and Retry for a disabled-studio informational note. The Team page displayed a contained streak tile and Team chart cards. Only the user's existing Chrome session was used; no live gym writes or Team sharing changes were made.

Local fixture after: Team card and chart renderers are shared by Team and personal views. The private aggregate supplies accurate class-local hourly counts and remains owner-scoped; its existing four-hour counts remain available. The 30 viewer-zone days use Monday-based alternating week backgrounds. Coverage notes remain visible; Retry appears only for a failed import.

Chrome local fixture evidence: [320 px](320.png), [390 px](390.png), [desktop](1200.png). At 320 and 390 viewport widths body scroll width matched the viewport and each slide matched its rail (278 and 348 px respectively). Desktop showed four chart cards in its grid and hid dots. At 390 px, reduced-motion dot selection reached page 3 (scrollLeft 716, current index 2); a touch swipe reached page 4 (scrollLeft 1072.5, index 3). Edge mask computed to none. Screenshots use simulated viewports, not physical iOS or Android.

Node 22.23.4: `npm test` output 122/122 server suites, 122 client test files and 982 tests passed. Focused personal-history server test additionally passed after adding exact hourly, deduplication and class-zone assertions. `npm run build:client` succeeded; Vite reported its existing >500 kB chunk warning. No production, push or deployment was performed here.

## Onboarding and Home polish

2026-11-08. Local fixture in the user's real Chrome: the studio-linking screen showed the visible “Tap the logos to pause” hint, and a synthetic future favorite rendered through the Home card component showed `⚡︎Quick-Book`. After the edits, a real reload had no hint node/text; the Home card showed `Quick-Book` with no icon. The logo strip's keyboard/pointer pause behavior and accessible label remain; the Team card still receives its existing action glyph. The synthetic favorite was rendered only in the local browser and did not create or alter any account or gym data.
