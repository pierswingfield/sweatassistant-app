# Personal statistics and onboarding — local implementation, 2026-11-08

Implemented and verified locally. **No deployment, host access, infrastructure change, commit, push or merge.** Production was not checked or changed. Existing untracked character art, screenshots and design artifacts were preserved.

## Changes

- Welcome and studio bubbles use the requested exact copy and centered compact text; signup success toast removed.
- Studio logos use stable paired tracks, decoded fixed-size assets and a 16px/s linear infinite animation. Strip activation persists pause; keyboard Enter/Space and temporary focus/hover pause work. Reduced motion uses a static manually scrollable strip, without a visible Pause Logos button. Duplicate track is decorative.
- Optional Auto-Upgrade setup remains OFF and disabled until actual saved preferred slots exist in an eligible linked gym. Preferences are checked per gym, rechecked before enabling and after map mutations/return, with only eligible gyms updated. Pending saves block finish; failures roll back unchecked without a tick. Existing enabled accounts retain the Settings guidance and Settings OFF escape.
- Timetable date scroller's right mask is fully opaque, so it no longer fades or whitens content; no overlay was added. Its left mask and all other scrollers retain their behavior.
- Teams initial loading uses decorative list/card skeletons with `Loading Teams…` and `aria-busy`; loaded content survives refresh. Empty pitch has precisely two benefits, exact requested wording and distinct CTA spacing. At 320×568, Create spans y295–339, above bottom navigation.
- About chooses valid local mascot art per section entry and falls back to referee. Tour/purpose/privacy order and encryption/decryption explanation remain intact; only the final backup/copies summary clause was removed, including its duplicate token. Legal drafts were not edited.
- Entire Upcoming favourites widget hides only after confirming no saved favourites across all linked gyms. A saved favourite without an upcoming class keeps the true empty state; unknown gym counts never become zero. Mutation/link/account context changes update the decision.
- Find a class shows the exact two-line invitation only after a successful complete booking read with zero future bookings. Confirmed future bookings hide it; no-gym connection state is preserved.
- Your activity now shows private history habits: weekly streak, 30-day daily line, then 90-day weekday, gym-mix and six four-hour-bin charts. Native horizontal rail, focusable data points with visible readout, table alternative and previous/next controls. No Team goal/sharing projection or duplicate instructor chart.

## History and privacy

`server/class-history.js` remains the only history-table owner. Authenticated `GET /api/personal-stats?zone=…` scopes to the account's linked gyms, returns `private, no-store`, and sends bounded buckets/coverage rather than raw rows. It aggregates all stored eligible history without the list endpoint's 1,000-row or 3,650-day caps. Multi-seat dedupe uses gym plus event, with booking-ID fallback; only past attended/unconfirmed records count, excluding known in-progress durations. Viewer-zone Monday–Sunday weeks and calendar days handle DST; habit day/time buckets use the class's zone. Invalid viewer zones fall back to UTC.

Link/relink/first access and six-hour stale refresh reuse the existing single-flight history pipeline and 14-day incremental overlap. A paced per-account loop starts established missing/stale imports; Home uses an account/zone-scoped cache and bounded follow-up. Coverage distinguishes pending/ready/stale/failed/disabled and explicit provider page-limit truncation. Failed refreshes preserve existing history. Unlink remains authoritative, including unlink during a pull. Provider safety guards still cap at 60 pages. These are past bookings, **not certified attendance or guaranteed lifetime completeness**; older provider history is included when returned, even before the app account existed.

## Checks and actual output

Node **v22.23.4**, local only:

```text
npm test (initial run)
🎉 122/122 server suites passed.
Client: 7 failures in obsolete attendance/setup expectations and a new copy reference.

npm run test:client (after fixes, final source)
Test Files  122 passed (122)
Tests       981 passed (981)

npm run build:client
✓ built in 1.44s
Warning: Some chunks are larger than 500 kB after minification.

git diff --check
(no output, exit 0)
```

The initial full command's client failures are retained in [initial output](initial-full-test-output.txt); they were resolved and the complete client suite rerun. Server source was unchanged after its 122-suite pass. [Final client output](client-test-output.txt), [build output](build-output.txt). New private-history suite covers >1,000 rows, 600 consecutive weeks predating account creation, gym/event collisions, guest duplicates, missing event IDs, outcomes, future/end times, zero buckets, DST/multiple zones, year boundary, current-week grace, missed week, partial/disabled states, unlink and private endpoint authorization. Deliberately removing account scoping caused `1706 !== 1705`; source was restored ([mutation evidence](privacy-mutation-output.txt)). New client checks cover chart accessibility/coverage, saved-slot gym eligibility, failed-save lifecycle, saved-favourites visibility and stable linear marquee pause.

## Real Chrome evidence

Attached to the user's existing Chrome via CDP 9222. Opened/reused one owned tab and closed it at completion; existing user tabs were preserved. Before evidence came from the existing localhost:5173 mock app. After checks used a separate fixture DB at `/tmp/dibs-personal-review.sqlite`, server 3001 and Vite 5174. No live gym or production-account writes. Fresh checks bypassed service worker/network caches and cleared the isolated preview's CacheStorage/IndexedDB. These are viewport simulations, not physical iOS/Android/PWA-install acceptance.

- [Before Home](home-before-390.png), [welcome](welcome-before-390.png), [gyms](gyms-before-390.png), [setup](setup-before-390.png), [About](about-before-390.png), [Teams](teams-before-390.png), [timetable](timetable-before-390.png).
- [Home / zero-favourite visibility / finder copy](home-after-390.png), [charts 390](personal-stats-after-390.png), [charts 320 dark](personal-stats-after-320-dark.png), [desktop dark](personal-stats-desktop-dark.png). Seeded history predates fixture account creation.
- [Exact welcome copy](welcome-after-390.png), [welcome 320 dark](welcome-after-320-dark.png), [studio strip](gyms-after-390.png), [reduced motion](gyms-reduced-motion-320.png).
- [Teams 320 empty pitch](teams-empty-after-320.png), [delayed skeleton](teams-delayed-skeleton-390.png), [error/retry](teams-error-retry-390.png), [About](about-after-390.png), [date row](timetable-after-390.png).
- [Auto-Upgrade disabled](setup-disabled-after-390.png), [saved slots unlock](setup-saved-slots-enabled-390.png), [failed enable without tick](setup-failed-enable-390.png), [saved favourite without upcoming match](favourite-without-upcoming-390.png).

[State outputs](browser-states.json) record delayed Teams busy=true/two cards/no empty pitch, resolution/busy=false/two rows, useful retry, favourites none→saved-no-match→removed and setup disabled→eligible→save failure. These controlled state variants substitute local API responses in the real running browser; they do not claim persisted live-account state.

[Animation outputs](browser-animation-and-charts.json): track 750px / 46.875s = 16px/s, measured −8.8px in 550ms. Controlled animation-time samples through two complete cycles give identical repeat positions at 1×/2× with no layout gap. This is phase-boundary verification, not a claim of waiting through two natural 47-second cycles. Logo failure kept track width 750px. [Fresh foreground focus checks](browser-focus.json) supersede earlier background-tab focus samples: actual focused circle exposes `2026-10-10: 2 past classes`, focus pauses strip and blur resumes; reduced motion has role=group, paused=true, transform=none and manual overflow. [Date computed styles](date-row-computed.json) confirm no right transparency/overlay.

## Review artifacts and limits

[Exact source/test diff, including new files](implementation.patch) · [changed-file list](changed-files.txt) · [implementation status](../../../Workstreams/HOME-PERSONAL-STATS-IMPLEMENTATION-2026-11-08.md).

Local review URL: `http://localhost:5174/` (isolated fixture services left running). Original 3000/5173 services were preserved. No physical phone, real provider history-completeness audit or incoming-link OS test was performed. Official PWA link behavior remains the researched answer in the design brief; no association/manifest/routing change was requested or made.
