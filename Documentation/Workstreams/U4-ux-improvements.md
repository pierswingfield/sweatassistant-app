# U4 — UX improvements (user list, 2026-09-29)

**Priority:** P2 · **Size:** ~4–5 days · **Depends on:** nothing hard; U4-1 and U4-7 touch the timetable, the main acceptance screen · **Blocks:** nothing

> **Verify first:** see [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md). Every item here is user-visible, so check it in a real browser before and after, at iPhone width (402pt) as well as desktop, in both themes.

Requested by the user after dev-twin testing on 2026-09-29.

| # | Item | Notes | Est. |
|---|---|---|---|
| U4-1 | **Mobile-optimise My Bookings → Active Bookings.** The cards are crowded and too tall on mobile. | Reuse the Auto-Book card styling where possible (U3-5 card typography is related). | 0.5–1 day |
| U4-2 | **Header gym chips as page-load indicators.** While a request that fills page content is in flight (timetable, My Bookings, …), animate that gym's header chip: either a circular progress border, or a clock-style fill like an iOS app icon installing. It advances in stages, not at a fixed rate. It must cope with slow gym APIs: an asymptotic curve that never "completes" early, finishing on the response. Background refreshes don't animate. Per gym, so a merged view shows each gym's progress separately. | Pairs with U4-7. Respect `prefers-reduced-motion`. | 1 day |
| U4-3 | **Native rubber-band scrolling on all pages.** Over-scrolling a page that doesn't overflow should spring back, like native iOS. | Probably blocked today by `overscroll-behavior`, fixed-height panels or the pull-to-refresh handler (`pulltorefresh.js`); keep pull-to-refresh working. Check the installed PWA as well as Safari. | 0.5 day |
| U4-4 | **My Bookings: vertically align the "Refreshing…" chip with the subheading** (e.g. "Active Bookings"). | CSS only; mind the `!important` gotchas in AGENTS.md. | 30 min |
| U4-5 | **Header: show ∞ instead of "Member" for unlimited gym connections.** When a connection's included bookings are unlimited, e.g. a JAB membership, show an infinity symbol. **Per account, not per gym**: other JAB users hold credits instead, so they see a count. Drive it from the normalized eligibility or membership data ("unmetered for this account"), not a gym id. | `client/src/main.js renderGymBadge` (C3-3) | 1–2 h |
| U4-6 | **Evaluate changing the app name shown in notifications.** Web Push on iOS/Android shows the PWA's name from `manifest.json` (`name`/`short_name`), and some platforms show the origin. Find what is controllable per platform (manifest name, notification `title`, a `badge` icon) and recommend. Evaluation first, then a change if one is cheap. | `client/public/manifest.json`, `server/push.js`, `sw.js` | 2 h eval |
| U4-7 | **Timetable: progressive multi-gym load with a 4 s grace window.** Gyms respond at very different speeds. If every gym answers within 4 s of load start, render them together. After 4 s, render what has arrived and mark the gyms still loading (tie into U4-2's chip indicator), then merge each late gym in as it lands, without a reflow jump or losing scroll position. | `api.getTimetable` fan-out (`api.js`), `timetable.js` render; the schedule cache already makes warm loads fast | 1 day |
