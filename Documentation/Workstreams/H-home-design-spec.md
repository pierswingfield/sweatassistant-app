
Timezone follow-up 2026-10-20: share-time tests now explicitly inject the viewing device zone, covering London-local output, London BST viewed from New York, and New York ET viewed from London. Default and `TZ=America/New_York` client suites each pass (91 files, 675 tests); client build and `git diff --check` pass. Real Chrome remains limited to its 402×874 iPhone preset because DevTools viewport controls are disabled and CDP 9222–9224 refuse connections; exact 390×844 and dark-mode browser evidence remains outstanding.

## Bounded layout/order pass — 2026-10-20

Before-change evidence: user Chrome at `http://127.0.0.1:5174/` (mobile viewport 302×874) rendered Home with the wrapper `padding: 61px 8px 92px`, the Home panel `padding: 0px 12px`, and the favourites rail/card starting at x=20; the panel is narrower than the viewport and the rail cannot use the outer gutter. The visible widget DOM order was Booked Classes → Find a class placeholder/action → Upcoming favourite classes → Credits & passes → Auto-Book queue, while the widget registry/mobile flow arrays place `book` before `auto-book-count`. `home-book-all` uses CSS `order: -1`, putting All gyms before linked gym actions. Queue markup splits its title/count over two lines, and View all bookings has no trailing arrow. The required selectors/functions remain active in `client/src/styles.css`, `client/src/ui/home.js`, and `client/src/ui/widget-registry.js`.

Root cause recorded before edits: the Home panel's 12px inline padding compounds the app body's 8px gutter, the favourites strip is confined to that padded panel width, mobile queue order follows an array that puts Auto-Book after Find a class, and the booking-row CSS explicitly orders All gyms first. No Home-only body top-padding override exists.

A parallel read-only cache diagnosis found Home clears/remounts widget sections on refresh and `mountWidget` always installs a skeleton, while account-scoped IndexedDB SWR and `beginGymLoad`/`endGymLoad` already exist. That cache behavior is outside this bounded layout pass; next work should separately address favourites, credit/instructor content, then the cache behavior.

Result for this bounded pass: Home panel padding removed; Home scrollport top padding cleared with the fixed-header clearance kept in the Home header; favourites rail now reaches the app-body right edge while its first card aligns with Home content. Auto-Book queue precedes Find a class in both flow arrays and uses one-line `Auto-Book queue` + `X Pending` (`0` when empty). Gym actions precede All gyms; local Chrome and a production-stylesheet DOM fixture confirmed 1/4/5/7 actions as rows `[1]`, `[4]`, `[3,2]`, `[3,3,1]`, with partial rows centered. View all bookings has an arrow. Client verification passed (91 files, 676 tests), build passed with Vite chunking warnings, and `git --no-pager diff --check --no-ext-diff` passed. Chrome was 302×656 CSS px in an iPhone 16 Pro 402×874 preset displayed at 75%; desktop and exact 390×844 visual checks remain outstanding. No deploy or commit. Next: separate passes for favourites, credits/instructors, and cache behavior.

## Favourites parity — before-change evidence (2026-10-20)

Code check: `home.js` renders `home-favourite-class` by concatenating discipline/name/studio fields rather than `cleanClassName`; `home-favourite-meta` appends date before gym mark; and the CTA writes only the action label. `timetable.js` already exports `primaryActionForEvent()` backed by its shared `eventActionState`/`buildActionModel`, and `home.js` passes that helper into each card. Both Home release status and timetable booking modal call `formatInZone(..., zoneFor(event))`, so timezone formatting is already aligned in code and was not changed in this pass. Browser check: local user Chrome at `http://localhost:5174/timetable?gym=aarmy` showed live class rows with Quick book; returning Home showed favourite cards with `BST` travel labels and Quick book, matching the loaded open-class state. The app has the observed account/session already loaded; no booking action was invoked. The requested original spec path `/Users/pierswingfield/.codex/worktrees/0c0e/App/...` is absent on disk; this current checkout contains the handoff spec, so evidence is recorded here.

Root cause before edits: Home favourites duplicated timetable class-name composition and CTA visual markup; date metadata was appended before the gym mark despite CSS ordering the mark after it. Eligibility/open-booking logic and timezone formatter were already shared with the timetable, so those paths need regression coverage rather than new policy.

## Favourites parity — result (2026-10-20)

Home cards now put the gym mark left of the date, display the same normalized class-name text as the timetable via `cleanClassName`, and render the shared timetable action glyph in `.app-seg-ico`. The Home card already used `primaryActionForEvent`, so eligibility/open-booking logic was kept centralized; regression tests pin eligible future-release, open, no-release per-class, and ineligible outcomes. Both surfaces already used `formatInZone(..., zoneFor(event))`; explicit travel-zone tests now cover BST viewed from New York and ET viewed from London. Local Chrome confirmed current open cards render with the BST suffix, normalized class names and Quick Book; no closed-release class was present in the visible data. QA evidence and command results are in `QA/browser-runs/home-favourites-parity-2026-10-20.md`. Client suite: 91 files / 679 tests pass. Client build passes with Vite chunking warnings; `git diff --check` passes. Exact 390×844 evidence remains outstanding. No commit or deploy.

## Credits and instructor card pass — before-change evidence (2026-10-20)

Code check: `getHomeCreditRows()` omitted a linked metered gym when its confirmed credit array summed to zero, and omitted an unmetered gym unless eligibility confirmed active membership. Missing per-gym credit/eligibility data also omitted the gym row entirely. Browser check: real Google Chrome, local preview `http://127.0.0.1:5174/`, linked three-gym account; the visible data currently has three positive/active rows, so the zero/no-membership defect is covered by pure tests rather than this account's current data. At the observed 302px CSS viewport, Credit tiles were 90×126px while Activity tiles were 90×104px; each Activity gym mark was 28×28px. Instructor cards were about 272px wide in a 287px container, with a 36px portrait/fallback and a 28×28px gym mark separated at the far right. Chrome's visible screenshot and DOM geometry were captured during this pass.

Root cause before edits: row construction treated zero or inactive access as no useful row, and returned early on missing keyed answers; the credit and activity tiles had separate dimensions. Instructor markup placed the gym mark after the text without grouping it with the portrait.

## Credits and instructor card pass — result (2026-10-20)

`getHomeCreditRows()` now emits exactly one row per linked gym from Home context, including confirmed zero credits and confirmed no membership. A missing or failed per-gym answer stays `null`/unknown and renders `Unavailable`; it never becomes a displayed zero. Inactive membership does not carry guest-pass counts. Credit and Activity cards share a 132px minimum footprint, and the instructor card fills its available column with its existing photo/initial fallback beside a 24px gym mark grouped with the 36px portrait.

Chrome evidence is recorded in `QA/browser-runs/home-credits-instructors-2026-10-20.md`. The 302×623 mobile preview showed 90×132 credit and Activity tiles, plus 286×60 instructor rows; a temporary 1280×900 viewport showed 132px tiles and 435×60 instructor rows in the desktop column. The identity pair is vertically centered, with the mark 24×24 and portrait 36×36. The current mock data exposes three linked gyms with positive/active entitlements; tests cover zero, inactive membership, unknown/failure, and 1/3/4 linked gyms. Photo URLs were absent in current mock data, so the visible initials exercised the fallback; the DOM test covers both image and fallback markup.

Verification: Node 20.19.0 `npm run test:client` passes (91 files, 682 tests); `npm run build:client` passes with Vite's existing mixed-import and >500KB chunk warnings; `git diff --check` exits 0. No staging, commit, or deploy. Next: a separate cache pass for Home cards, including whether widget refresh clears the visible card shell and how account-scoped SWR can preserve a useful stale card during refresh; do not broaden this credit/instructor change into cache work.

## Home cache and source-progress pass — result (2026-10-20)

Before-change evidence: local Chrome on `http://127.0.0.1:5174/` showed Home skeletons during source loading, then populated cards. Code confirmed every `renderHome()` call fetched linked gyms, cleared and recreated the widget DOM, and mounted skeletons unconditionally. A refresh could therefore flash placeholders and lose the mounted card state. Existing per-account IndexedDB SWR TTLs were retained: bookings 120s, Auto-Book and Auto-Upgrade 30s, credits 60s, membership 10m, eligibility/favourites/attendance/metadata 5m, and history 6h. The timetable bootstrap also bypassed cache for bookings and metadata; those two calls now share Home's explicit gym-keyed caches.

Home now reuses its mounted widgets while account and linked-gym context match, probes every required account-scoped source key before showing a cold skeleton, and retains successful content during stale refreshes and failures. Account/gym context changes replace the old widget tree; late credit/favourite responses cannot repopulate shared maps after that change. A miss or stale background request uses the existing counted `beginGymLoad`/`endGymLoad` header indicator. Manual Home pull refresh explicitly invalidates all Home source keys. Cache misses deduplicate, in-flight misses retry after same-account mutation invalidation, account changes reject old flights rather than retrying under the new prefix, and a failed background cache write emits no refresh event.

Real Chrome after-change evidence: a warm reload rendered 7 unique widgets with 0 skeletons. An immediate repeat reload made no Home source GET requests within the source TTLs; `/api/bookings/sync` remained as the local timetable booking-cache sync. To exercise stale SWR using controlled local mock requests, cache rows were made stale and network latency was throttled: favourite and credit card text remained unchanged while all three gym header badges showed `aria-busy=true`, then all indicators cleared and widgets returned to ready state. The pre-change cold-load skeleton was observed before edits. No gym write or deployment occurred.

Verification: focused cache/Home/registry regression tests passed (3 files, 50 tests). Full client suite passed (91 files, 688 tests); the client build passed with Vite mixed-import and >500 kB chunk warnings; `git diff --check` passed with no output. Exact commands and browser evidence are recorded in `QA/browser-runs/home-cache-2026-10-20.md`.

## Final Home UI acceptance — 2026-10-20

Independent read-only real Chrome check on the local Vite app (`http://127.0.0.1:5174/`) at explicit 390×844 and 1280×900 viewports. Both document widths matched the viewport. At 390×844, `.app-body` and the Home panel had `padding-top: 0`; the panel/content edge and first favourite card both began at x=8. The favourites rail began at x=8, measured 382px wide with its right edge exactly at x=390 (`margin-right: -8px`), and had 592px of horizontal scroll content without document overflow. The visible favourite placed its JAB mark before the right-aligned `WED 21 OCT · 06:30 BST` metadata and showed the normalized class name `Core & Power`.

The one-line Auto-Book queue showed `2 Pending` above Find a class. Three linked-gym actions filled one row; All gyms filled the 374px mobile row. At 1280px, the three gym actions were equal 212px buttons in a 653px row, and All gyms filled that row. The screenshots showed equal 132px credit/activity tiles and full-column instructor cards (374×60px mobile; 435×60px desktop), with the 24px gym mark grouped beside the 36px portrait/initial. Desktop document width also matched its 1280px viewport. The non-Home timetable retained its existing 10px `.app-body` top padding and had no horizontal overflow.

The visible account had no Booked Classes item, so its View all arrow could not be checked in the rendered page; the preceding implementation record documents its arrow and unit coverage. Current credits were positive/active, so zero-credit/no-plan rendering was not visually available; unit coverage is documented in the credit/instructor result above. No booking CTA was activated, and no cache was cleared. CUA screenshots were shown inline, but no local screenshot files were produced because the available local CDP ports were unreachable. This browser-only acceptance records no test/build result and no deployment.
## Dev deployment — 2026-10-20

Deployed the complete Home build from isolated snapshot commit `f9750cab2bfba5f4886a6309735c46d7f6863494` with the default `./deploy.sh` to Oracle `~/services/sweatassistant-dev`. The shared source checkout remains dirty and unstaged; its existing changes were not reset. The snapshot includes this spec, the current Home/cache/layout/favourites/credits/instructor work, and the already-present MarianaTek attendance and booking-portrait dependencies.

Verification from the snapshot: Node 20.19.0 `npm test` passed (91/91 server suites; 91 client files, 688 tests). `npm run build:client` passed (96 modules; existing mixed-import and >500 kB chunk warnings). `git diff --check` passed. Docker rebuilt the image and recreated `sweatassistant-dev`; `docker ps` reported `Up` with `100.86.226.52:3005->3000/tcp`. `docker inspect` showed networks `edge` and `sweatassistant-dev_default`; pre-recreate `docker diff` reported only `A /data`, which remains mounted. Tailnet `/api/health` returned HTTP 200 and `status: ok`.

Served asset SHA-256 values matched the snapshot build byte-for-byte: `index-Dp_MuE6q.js` `f3f1810b72c9ffbd7f87eb036ca56690e913af5c345b1c4a31a8a8cb358cb7d2`, `index-tCo8frlH.css` `8253b7ee83a6e8ed7963e901ef630444a9d500e02a95a27d4a11d8db655c42fe`, and `home-CWFpbOYF.js` `ed104785e6b8a508e41794510250a6d50e91c07ff77ba3aca7015284bfc01783`. The user's real Chrome reloaded the signed-in dev app and rendered Booked Classes, three gym actions, attendance, Credits & passes, Auto-Book queue, upcoming favourites, and Familiar instructors. A direct unauthenticated public probe returned HTTP 302 to Cloudflare Access; the signed-in browser session loaded the app. No live-gym writes or production deploy occurred. No port, bind, database, or exposure change occurred.

## Home release and action parity diagnosis — 2026-10-20

Real Chrome on `sweat-dev.wingfield.tech` reproduced the release mismatch on Home: Johan's Signature 45 at Oxford Circus (Wed 21 Oct, 06:30 BST) showed “Opens Mon 26 Oct · 12:00” and Auto-Book. A separate signed-in timetable view filtered to Psycle showed the same Johan event and Aanya's Signature 45 at Oxford Circus (Wed 21 Oct, 18:30 BST) with Auto-Book, so Home and timetable agree for these events. Source inspection confirms Home consumes the timetable's loaded event objects and calls the exported timetable `primaryActionForEvent`; `/api/timetable` stamps per-user `releaseAt` after the shared schedule cache using the account's resolved booking window. The exact normalized `startAt`/`releaseAt` payload and profile cutoff were not captured, so whether the wrong release originates in provider resolution, stale account profile, or upstream data remains unresolved. No release math was changed without those inputs. Next: read-only capture the same event's normalized timestamps, profile cutoff, and release window, then apply and verify the smallest correction with a regression for the reported imminent-class case.

Separate visual follow-up from Chrome audit: remove the unused hidden `.ab-card-rail` that still reserves 3×44px and makes JAB cards taller; align the shared raw instructor name under ten characters with the class title while preserving the long-name right-aligned two-line behavior. These are not part of the release diagnosis.

## Home rolling-weekly release refresh fix — result (2026-10-20)

The stale release was caused by using the profile's stored booking cutoff after it had become outdated. The profile, timetable, and event-detail routes now refresh the required rolling-weekly profile through the existing provider memo, persist the result under the explicit gym, and apply it to the response. `server/test-timetable-profile-refresh.js` covers refresh ordering, gym isolation, and failure behavior. Verification passed: 92/92 server suites and `git diff --check`; this fix is not deployed. The separate Home card pass remains as recorded below: Home alone drops its unused action rail, and instructor names under ten characters center under the avatar while longer names retain the existing right-aligned two-line treatment; client verification passed at 690 tests with the build and diff check green.

## Instructor card spacing and labels — 2026-10-20

The Home-only action rail was still in layout after its footer was removed. On sweat-dev, it forced a JAB Home card to 134px with a 70.5px body; its three hidden action buttons were 44px tall. Home now removes that unused rail. The shared instructor label uses the raw, trimmed Unicode code-point count before HTML escaping: names under 10 characters center under the avatar; names of 10 or more stay right-aligned and clamp visually to two lines. The full accessible DOM text is retained.

Verification: real Chrome on the local Vite checkout retained all six My Bookings card rails and both Auto-Book queue card rails. The local Home dataset had no booked-card row, so a temporary DOM fixture with the checkout stylesheet verified geometry and short/long name alignment ([QA run](../../QA/browser-runs/home-instructor-card-layout-2026-10-20.md)). Node 20.19.0 client tests passed 92 files / 690 tests; client build passed with the existing mixed-import and large-chunk warnings. The release-time diagnosis remains separate and unresolved: the read-only profile cutoff is Oct 20 while last sync is Oct 11; continue tracing the profile and normalized event release payload.

## Home header and actions pass — result (2026-10-20)

Home section headers now use `h3` elements and the shared page-title typography. The Booked Classes heading includes the number of future class occurrences grouped by gym and event (even though at most three booking cards render), with View all bookings at the heading's right edge in empty and populated states. The strip follows the Home page header directly, keeps its existing day links/labels, and clears when the widget leaves strip mode. Home gym actions use wide brand chips; the merged timetable action uses the calendar icon and “See full timetable”. Queue count sizing/gap are smaller and day borders are removed.

Real Chrome on the local Vite preview verified 390×844 and 1280×900. At both sizes populated `3 gyms` metadata ended exactly at the heading's right edge; wide chips measured 103×48px mobile and 120×48px desktop; mobile document overflow was 0px. The local fixture had no upcoming bookings, so visible strip click/navigation remains source/unit-verified rather than browser-clicked. Focused Home/upcoming/widget-registry tests passed (47/47); the full client suite passed (92 files, 691 tests), the client build passed with existing mixed-import and large-chunk warnings, and `git diff --check` passed. No commit or deployment was made.

## Home upcoming-strip duplicate fix — result (2026-10-20)

The repeated Home render path inserted a new `.home-up-strip` after the page header but cleanup removed only the first existing strip. Cleanup now removes every direct-child strip before inserting the single current strip, and empty/card/context-clear paths remove all strips. A focused regression covers repeated renders, pre-existing duplicates, direct-after-header placement, native day links, and empty-state removal.

Verification: focused Home tests passed 33/33; full client suite passed (92 files, 694 tests); client build passed with existing Vite mixed-import and >500 kB chunk warnings; `git diff --check` passed. The existing real-Chrome duplicate finding was fixed in source and browser verification could not be repeated in this turn because the CUA tab was already claimed by another browser session; exact 390×844/1280×900 post-fix evidence remains outstanding. No commit or deployment.

## Home credits and attendance infographics — result (2026-10-20)

Home credits now keep the balance prominent while placing its kind beside it on the same visual line; membership, unavailable, and unknown states retain readable text without numeric-only styling. Attendance shows a prominent number with an inline “classes” unit. Linked-gym rows and provider-only attendance semantics are unchanged. Mobile-only rules hide credit gym names, the activity subtitle, and attendance gym labels; desktop labels remain present. “Familiar instructors” is now “Your trending instructors”.

Verification: Node 20.19.0 focused Home tests passed (32/32), full client tests passed (92 files, 693 tests), client build passed with existing Vite mixed-import and >500 kB chunk warnings, and `git diff --check` passed. Real Chrome loaded the local Vite Home and visibly showed the renamed heading, credit kinds/balances, membership and guest-pass state, and “classes” units. The available CUA browser was at a mobile viewport approximately 302px wide (exact viewport metrics unavailable); exact 390×844 and 1280×900 checks were not rerun in this documentation-only follow-up. No commit, deploy, or live write.

## Home favourite release and card layout — result (2026-10-20)

Future releases now use the shared relative `formatOpensIn()` wording (`Opens in …`) and the existing timetable release/action model; expired, absent, and unknown releases retain the normal shared CTA/neutral availability behavior. The status is directly beneath the date stack, the footer wrapper is removed, and the CTA is anchored inside the card body. The mobile rail bleeds both app-body edges while its initial card remains aligned at x=8.

Verification: Node 20.19.0 full client suite passed (92 files, 694 tests); focused Home tests passed (33/33); shared lib/Auto-Book tests passed (32/32); client build passed with existing Vite mixed-import and >500 kB chunk warnings; `git diff --check` passed. Real Chrome on local Vite verified 390x844 and 1280x900 geometry, CTA/body placement, DOM order, no footer, and horizontal scrolling (`scrollLeft=390`, next card passed the x=8 edge). The visible fixture showed open Quick Book cards but no closed-release countdown card, so that state remains unit-verified only. No commit, deploy, or live write.

## Final Home acceptance — result (2026-10-20)

Real Chrome CUA verified the local mock at exact 390×844 and 1280×900. After three Home reloads and a manual refresh, exactly one `.home-up-strip` remained directly after the Home header and before Home widgets; the native day link remained `/bookings?day=2026-10-21`, and document overflow was 0 at both sizes. Tomorrow's JAB and Aarmy timetable rows matched Home's open Quick Book state. Booked Classes headers/counts, credit and attendance tiles, trending-instructor label, Bookings rails, and Auto-Book rails were present at both viewports. The Aarmy 9603 event is intentionally outside Home's seven-day favourite horizon: Sunday 1 November, release 22 October. A temporary browser fixture for 9603 rendered `Opens in 2 days`, status under the date, `☆Auto-Book` inside the body, and no footer; it was removed after inspection. Development verification remained 92/92 server suites, 694 client tests, build and diff check passing; no deploy.

## Home foreground lifecycle and first-load clearance — result (2026-10-20)

The deployed dev Home reproduced the foreground lifecycle: `visibilitychange` calls `renderHome()`, which refreshes every mounted widget. The shell sections were already reused for the same account/gym context, but `mountWidget()` always cleared and rebuilt each widget body, while `paintHomeGreeting()` replaced the greeting subtree. This reset DOM identity during a foreground refresh even when all widget data was unchanged.

Home now retains the existing greeting and widget body when the account/gym context and rendered data are unchanged. The favourites widget adds its release-derived status and action to its render key, so unchanged event payloads still repaint at a release boundary; the generic regression covers Auto-Book changing to Quick book with a fixed clock. Account/gym context changes, changed data, and stale-refresh failures retain their existing behavior.

Read-only live `sweat-dev` cold-load evidence at 390×844 found a 41px header ending at y=41 and the Home greeting starting at y=45: the visible clearance is the intended 4px after the fixed header, not a 45px blank margin. A true foreground cycle retained that geometry and seven widget shells. At 800px and 1280×900, the visible 39px header plus 51px desktop navigation placed Home at y=90 with no extra reservation. The reported first-load versus revisit geometry difference was not reproduced. Local Chrome at exact 390×844 confirmed no horizontal overflow, seven widgets, y=41/45 header/greeting geometry, and stable CDP backend node identities for both a widget button and the greeting across a real foreground cycle; 1280×900 retained two Home columns without overflow. Details: [QA browser run](../../QA/browser-runs/home-focus-firstload-2026-10-20.md).

Verification: focused Home/registry tests passed (47/47); Node 20.19.0 `npm test` passed (92/92 server suites; 92 client files / 697 tests); the client build passed with existing Vite mixed-import and >500 kB chunk warnings; `git diff --check` passed. No commit, deployment, or live-gym write occurred.

### Deferred follow-ups

- The live mobile favourite metadata/status overlap and portrait separation are a separate visual design task; no styling was changed here.

## Favourite-card and tile composition correction — 2026-10-21

Read-only sweat-dev evidence at 390×844 found the favourite date and availability beginning at the same y-coordinate while the 44px portrait occupied a separate strip. The cause was a mobile absolute-positioned metadata block combined with a one-column card, rather than a flowing card composition. The correction uses a portrait column, a 28px gym-mark gutter and one text column: date, availability, instructor and class therefore share one x-coordinate, the status follows the date in normal flow, and the CTA remains inside the body at its bottom edge. Long class names wrap safely.

Credits and activity now share a centred mark/value/detail composition. Credit balance and kind are grouped semantically; narrow tiles stack that group safely. Membership, unavailable values, confirmed zero and guest detail retain their existing data semantics. Local controlled fixtures at 390×844 and 1280×900 covered long class text, waitlist status, six-digit credits, Membership and Unavailable; all had zero measured overlaps and zero document/tile overflow. Live sweat-dev remained read-only and provides the before-change reference only; post-change acceptance is local-source Chrome pending the separate fresh-agent review.

## Home booked-day SPA navigation and Today cue — result (2026-10-21)

The Home five-day strip retained its real `/bookings?day=YYYY-MM-DD` hrefs, but ordinary primary clicks now use the existing router and switch to My Bookings without adding a second history entry. Modified, secondary and new-tab clicks remain native. Bookings therefore paints its cached cards immediately and retains its existing route-driven selected-day scroll and focus; Back, Forward and a normal refresh continue to hydrate the same day. The strip applies `is-today` from its existing viewer-local day model. Every tile reserves a transparent one-pixel border, while only the current viewer-local day receives the theme accent, keeping all tile geometry stable in light and dark themes.

Read-only Chrome evidence first reproduced the deployed dev failure: selecting `/bookings?day=2026-10-22` performed a document navigation. After the local change, Chrome at 390×844 switched to Bookings, focused the `2026-10-21` card, and showed an accent only on Today; Back, Forward and normal refresh preserved the selected day. At 1280×900, a navbar switch completed in 142 ms and the booked-day SPA switch in 94 ms, with the same document retained. No live-gym write, deployment, commit or staging occurred. See [QA browser run](../../QA/browser-runs/home-booked-day-spa-2026-10-21.md).

Verification: focused Home/upcoming/router/URL tests passed (89/89); Node 20.19.0 full client suite passed (92 files, 697 tests); client build passed with existing Vite mixed-import and >500 kB chunk warnings; `git diff --check` passed.

## Home compact controls and header spacing — result (2026-10-21)

Before-change read-only `sweat-dev` evidence at 390×844 showed `Booked Classes (2)`, a count-free `View all bookings →` action, and a two-entry queue. The short-name figure rule centered the entire 84px figure, moving its photo left relative to long-name cards; the underlying fixed right-aligned figure was already the correct stable column. The filter drawer’s selector plate resolved to a 30px container with 4px inline padding and a 15px full wordmark, while Home used a different 48px/24px chip. A separate spacing audit found Home inherited 16px internal header padding after its valid fixed-header/nav clearance: live mobile was app-bar bottom 41, header top 45, greeting lead top 61; desktop was header top 90, greeting lead top 106. This is a spacing correction, separate from the unreproduced foreground lifecycle symptom.

Home now keeps every instructor photo in the fixed right-hand slot. A short raw name stays centered in the 52px photo-width label under that photo; a long name remains right-aligned and two-line clamped. The Booked Classes title has no count; the preserved header action updates only its text to `View all N booking(s) →` after the grouped future-occurrence count loads, without replacing its node during Home refreshes. The queue uses 13px title text, 12px secondary count text, and a 4px grid gap. The filter drawer’s compact selector plate is now an extracted shared helper and class, so Home uses the same full logo asset, 30px container, 4px padding, and 15px wordmark. Linked-gym rows retain the existing one-to-four full-width grid and more-than-four centered rows of at most three.

Home-only header padding is now 0px at mobile, where the existing 4px fixed-header margin supplies the visible gap, and 4px at 800px/1280px. Chrome local-source checks at exact 390×844 measured mobile cold-load and revisit header top 45/greeting top 45 with zero overflow; 800×900 and 1280×900 measured header top 90/greeting top 94 with zero overflow. The 390px Home and live filter drawer both measured 30px height, 4px inline padding, and a displayed 15px full logo. See [QA browser run](../../QA/browser-runs/home-compact-controls-2026-10-21.md).

Verification: Node 20.19.0 focused Home/instructor/gym-brand tests passed (3 files, 50 tests); full client tests passed (92 files, 698 tests); client build passed with existing Vite mixed static/dynamic-import and >500 kB chunk warnings; `git diff --check` passed. No server suite, commit, deployment, or live-gym write occurred.

## Fresh local fixture and final Chrome acceptance — 2026-10-22

Fresh-agent review recovered the authorized local fixture rather than trusting
the prior process. Its old backend had become `503` because the calendar
heartbeat passed its health threshold. Restarting the same temporary database
on `49173` with its required photo-cache path restored direct and Vite-proxied
health to `200`; scheduler, poller, and calendar all reported healthy. The
restart intentionally cleared MarianaTek's in-process reservations, so the
review restored only the two authorized mock JAB bookings (9021 and 9026).
The resulting API returned two future Nickol bookings, two paused/pending
Auto-Book rows, and a real cached Nickol portrait (`200 image/webp`, 14,058
bytes, `X-Instructor-Photo-Cache: HIT`). No production, provider, remote, or
source state changed.

In a fresh real Chrome tab against local Vite, exact CDP-emulated 390x844,
800x900, and 1280x900 checks found zero document overflow. The 390 mobile view
showed Home edge/first-card x=8, populated Booked Classes, `View all 6
bookings →`, one-line queue copy, portrait-backed Nickol favourite, and the
Today border in light and dark mode. The `Fri 23: 4 classes` native day link
routed through the SPA to `/bookings?day=2026-10-23`, focused its matching
booking, and retained the route via Back/Forward. At 800 all favourite titles
and CTAs stayed within their cards; at 1280 the 1232px Home fit the viewport
and the portrait favourites plus three activity value/unit groups fit their
columns. A separate signed-in sweat-dev Chrome tab was inspected at 1280x900
as a read-only deployed baseline only.

Limits: the intentionally closed Aarmy 9603 event remains outside Home's
seven-day fixture horizon, so its `Opens in 2 days`/Auto-Book composition was
not asserted against actual current fixture data. The current fixture exercised
Nickol's short portrait; the disposable short/long-name DOM fixture was not
rerun. This pass did not rerun test or build commands; earlier 92-server/698-
client/build results are inherited evidence, not a new execution.

### Date-roll fixture correction

When the local date reached 22 October, the mock schedule advanced. The final
local-only refresh did not reuse the previously named dates: it seeded future
JAB events 9021 (`2026-10-24 10:00 +01:00`) and 9022 (`2026-10-24 11:00
+01:00`) and verified both through `GET /api/bookings`. PID 75720 then returned
direct and Vite-proxied health `200` with scheduler, poller, and calendar
healthy; the two paused/pending queue rows and the cached 14,058-byte Nickol
WebP remained present.

## Home cross-tab scroll-state correction — 2026-10-22

Read-only deployed `sweat-dev` Chrome at 390×844 did not reproduce the reported
sequence: Home returned with `Welcome!` at y=63 and every tested tab had
`main.app-body.scrollTop=0`. The inspection identified a standalone-WebKit
failure mode in source: the shared scroller's Home-only `padding-top:0` was
selected by `:has(> #app-panel-home[style*="display: flex"])`. A delayed
relational-selector invalidation can retain Home's zero padding for Bookings,
Auto-Book and Settings, or retain their header reserve for Home. That exactly
matches the reported cross-tab reversal; Timetable forces a separate layout
state and masks it.

`switchTab()` now owns this geometry through an explicit `app-home-active`
class alongside the existing Timetable class. The stylesheet no longer derives
the shared scroller's padding from a child panel's inline display state. Local
Chrome at 390×844, 800×900 and 1280×900 completed Home → Timetable → Home →
Bookings → Auto-Book → Settings → Timetable with scrollTop zero throughout.
At mobile, Home alone had 0px scrollport top padding and each other tab had
61px; tablet and desktop retained their 10px layout. Details:
[QA browser run](../../QA/browser-runs/home-tab-scroll-state-2026-10-22.md).

Verification: the new tab-state regression plus modal scroll-lock coverage
passed (2 files, 16 tests); Node 20.19.0 client build passed with existing
mixed dynamic/static-import and >500kB chunk warnings; `git diff --check`
passed. This is Chrome evidence; iOS standalone requires manual confirmation.

## Home section and card polish — 2026-10-22

Read-only sweat-dev Chrome at 390×844 and 1280×900 established the visual
baseline: the Booked Classes to Auto-Book queue gap was 32px, a favourite card
was 155.49px tall, and real Credit and Activity tiles resolved to `text-align:
left` even though their earlier rules described centered content. The cause was
competing late CSS: an old left-led grid block and a later terminal tile block
won over the intended centered composition.

The Home selector now gives the booked-card/queue sequence a 16px measured
gap. Favourites have a 56px portrait/instructor rail and three flowing body
facts (gym/date, one-line clean class name, availability/release); the shared
action remains in normal-flow at the body bottom right. The card uses the
existing `--surface-2` token for a slightly inset flat section/card surface.
Credit and Activity tiles are consolidated into one canonical centered grid
rule, preserving membership, true zero, unknown/error and guest-detail data.

Local Chrome at 390×844, 800×900 and 1280×900 measured a 16px gap, 128.25px
favourite cards, zero document/body overflow, and centered actual tile styles.
The 390px tiles used `rgba(31, 27, 22, 0.03)` (`--surface-2`). See
[QA run](../../QA/browser-runs/home-section-card-polish-2026-10-22.md).
Node 20.19.0 client tests passed 93 files / 699 tests; the client build passed
with the existing Vite dynamic/static-import and >500kB warnings; `git diff
--check` passed. Dark mode was not retested because its Settings control is
not present on the Home surface; no forced preference change was made. No live
gym writes, commit, staging or deployment occurred.

## Home authenticated cached first paint — 2026-10-22

The deployed dev baseline was read in Chrome before this change: the shell was
visible at 46/130/147ms, but the Home work did not start until 2.447s because
`initApp()` serially awaited the gym context and the complete per-gym
profile/credits/eligibility/settings refresh. Cached Home widgets therefore
could not mount until provider-backed profile requests completed.

The client now caches the authenticated `/api/gyms` catalogue and
`/api/my-gyms` link set through the existing account-prefixed IndexedDB SWR
store. After `checkAuth()` validates the token, that scoped context is enough
to establish header/theme/layout and route Home. `refreshUserData()` then runs
in the background and emits `app-user-data-refreshed`; Home reconciles changed
models through its existing stable-widget mounting path. Logout still clears
the complete API cache and key prefix; no HTML or cross-account page snapshot
was introduced. Cold cache remains loader-first, and a deep non-Home route is
still selected before the background refresh begins.

Verification: Node 20.19.0 `npm run test:client` passed 93 files / 699 tests;
`npm run build:client` passed (existing Vite mixed dynamic/static-import and
over-500kB chunk warnings); `git diff --check` passed. Local server and Vite
returned `200` on ports 3000 and 5174. Chrome reached local `5174` and
authenticated the mock account, but that account had no linked gym, so it
verified the legitimate no-gym route only and cannot establish warm linked-gym
card timing. A signed-in linked-gym Chrome recheck with throttled profile and
document navigation is required before deployment.

Limit found during the service-worker audit: navigation is currently an
unbounded `fetch(request).catch(cache)` network-first strategy. A hung network
can therefore delay the cached shell indefinitely; this pass intentionally did
not change it without a controlled service-worker timing reproduction, because
the cache shell and content-hashed assets must remain build-coherent.

## Home PWA shell deadline and linked-gym cache correction — 2026-10-22

The prior service-worker finding was reproduced in a worker harness: a warm cached shell still waited past 150 ms when its navigation fetch never settled. Navigation now gives a warm shell 700 ms for a fresh response, then returns this build's installed `/index.html`; a cold cache remains network-first and surfaces its real network failure. The pending navigation continues in the background and only updates the fallback shell when every referenced local hashed asset belongs to this worker generation's install manifest. API/auth and all non-GET requests remain outside service-worker caching.

The linked-gym mutation review found a second stale path: `linkGym()` and `unlinkGym()` left the five-minute account-scoped `/api/my-gyms` SWR entry intact, so Home capability context could remain pre-mutation. Both successful mutations now invalidate that exact entry before their callers reload context. Regression coverage exercises link and unlink against a populated account cache.

Worker-harness verification covers fast network refresh, offline cached shell, cold-cache failure, hung cached fallback, eventual coherent refresh, and rejection of a shell referencing a missing chunk; it also proves `/api/*` and POST pass through. Focused Node 20.19.0 client tests passed: 3 files / 26 tests. A linked mock Chrome warm-boot timing and real service-worker controlled reload still need local browser evidence before deployment; no source was staged, committed, or deployed.

## Home PWA controlled linked-cache acceptance — 2026-10-23

The outstanding linked-gym check was completed against the authorized local
fixture only. A production build was served at `127.0.0.1:4174` through a
same-origin proxy to the healthy fixture backend on `49173`; Chrome reported
an active controlling `/sw.js` and its stamped shell and asset cache
generation. The linked account rendered Booked Classes, the three-gym Credits
and passes panel, upcoming favourite cards, trending instructors, and the
two-item Auto-Book queue.

With Chrome networking disabled, a normal reload showed the offline banner and
all of those Home surfaces from saved account-scoped data, without skeletons.
For the bounded-navigation case the local document response was deliberately
held for 2,000 ms; the SW-controlled warm navigation completed in 768 ms and
then reconciled the same complete Home data. No `/api/*` response or mutation
was cached by the worker. The focused worker/cache/Home tests passed 52/52;
the full client suite passed 94 files / 708 tests; the client build completed
with the existing Vite mixed-import and over-500 kB chunk warnings; and `git
diff --check` was clean. No deployment, commit, staging, production access, or
live-gym write occurred.

## Header offset audit — 2026-10-23

The explicit `app-home-active` state replaces the stale parent `:has(...)`
dependency for the Home scrollport offset. Chrome coverage exists for the
state change; physical iOS standalone behavior remains unverified. A separate
source audit found that programmatic routing can leave the hidden-header
closure set (`main.js` around 676, 885, 1438, and 1844). That follow-up needs
its own scoped hardening task and was not changed during the PWA cache pass.

## Header route-reset hardening — 2026-10-23

At 390×844, local Chrome reached the mobile hidden/compact header state after
a downward wheel gesture. The earlier implementation cleared those DOM classes
only through navigation-button capture or a later scroll-to-top event. Direct
`switchTab()` callers could therefore retain the controller's closed-over
`hidden` state until browser event timing happened to correct it.

`switchTab()` now calls a reset closure installed by `initHeaderAutoHide()`.
It resets the scroll anchor and uses the controller's own state setter to show
the header and clear both compact classes, keeping its closed-over state aligned
with the DOM. The local Chrome regression starts hidden, routes programmatically
to Timetable, confirms the state is clear, then repeats hide/reveal on the new
tab. The Home cross-tab scroll-state change remains intact. iOS standalone is
still manual-device verification only.

Verification: in real local Chrome at 390×844, a native downward wheel gesture
set both hidden classes; a direct `switchTab('class-timetable')` immediately
cleared them and selected Timetable. The programmatic Bookings → Timetable →
Bookings → Home sequence cleared both at every transition. Home then hid at
scrollTop 220 and revealed at 100, proving the next hide/reveal still works.
At 1280×900, the same sequence ended on Home with both classes clear, scrollTop
zero, and no document overflow. This is Chrome evidence only; no physical iOS
claim is made. The separate visual QA found the 390/1280 light/dark activity
and credits values centred and the compact queue/favourite card layout intact,
but JAB Membership wraps into two oversized lines in the 119/140px tiles; that
is logged for a separate fresh task and was not changed here. A deployed
`sweat-dev` tab returned a Cloudflare 502 Host Error; deployment/service health
needs checking separately before and after any deploy.

Checks: Node 20.19.0 focused scroll-collapse and shared tab-state tests passed
(2 files, 7 tests). The client production build passed with the repository's
existing dynamic/static-import and over-500kB chunk warnings. `git diff --check`
passed. No commit, deployment, cache change, or gym write occurred.

## Membership tile typography correction — 2026-10-23

Root cause: the semantic JAB Membership value inherited the 1.55rem numeric
balance style. In the 119px mobile and 140px desktop tiles, that made the word
wrap to two oversized lines. The existing `.is-membership` state now gives only
non-numeric membership values a readable responsive one-line size; numeric
credit balances keep their infographic prominence. Guest-pass detail remains
in normal detail flow and can use two balanced lines at 320px without clipping.

Real Chrome local-mock checks found zero document or tile overflow at 390×844
and 1280×900 in light and dark themes. Membership measured 14.82px/one line in
the 119px mobile tile and 16px/one line in the 140px desktop tile; favourite
cards remained 128.25px high. At 320px Membership remained one line and Guest
passes was visible in two detail lines. The local theme and viewport were
restored after checking. Physical iOS standalone remains unverified.

Deployment remains blocked separately: the Oracle host was unreachable over
SSH and Tailscale, while the public dev health endpoint returned Cloudflare
530/1033 with no active tunnel. No infrastructure or deployment action was
taken here.

## Home summary tile refinement — 2026-10-23

Progress: Chrome baseline showed that Credits & passes exposed visible gym names,
metered-credit tiles went to Buy Credits, and Your activity retained an
all-time subtitle/divider while its tiles were noninteractive. The existing
per-gym Settings seam is `switchTab('settings')` followed by
`openGymSettings(gymId)`, which selects that gym's `gym-<id>` pane.

Decision: Home credits and attendance now use that per-gym Settings route.
The visible names, activity subtitle, and its divider are removed; accessible
button labels retain the gym identity. The two sections use 16px padded,
theme-aware wells with flat responsive square tiles, and the mobile Home
header clearance increases from 4px to 8px without changing fixed-header
behavior.

Checks: focused Home tests passed 35/35; the client build passed with the
existing Vite mixed-import and over-500 kB chunk warnings; `git diff --check`
passed. In local real Chrome, desktop tiles were square (129–202px) and the
Aarmy activity tile opened `/settings/gym-aarmy` with its Settings pane
selected. At 390×844 tiles were 167px square, and at 320px they were 132px
square; neither viewport had tile or document overflow. Dark-theme token
inspection kept the well and tile contrast readable. The local theme and
viewport were restored; no physical iOS claim, live-gym write, deploy, commit,
or staging occurred.

Next step: review the scoped Home changes with the rest of the in-progress
checkout before any release decision.

## Oracle dev release deployed — 2026-10-23

The prepared release snapshot commit `21b2818d0afe56e2826b7c58507a2d8288a5d3a1`
was deployed to the development twin only with the default `./deploy.sh` from a
clean isolated checkout. Before recreation, `docker diff sweatassistant-dev`
reported only `A /data`; `/data` is still bind-mounted. The recreated container
is Up on `edge` and `sweatassistant-dev_default` with the unchanged
`100.86.226.52:3005->3000` Tailnet bind. No production, database, port, bind,
or exposure change occurred.

Node 20.19.0 `npm run build:client` completed (97 modules; existing Vite
mixed-import and over-500 kB chunk warnings). Tailnet and public `/api/health`
both returned HTTP 200 and `status: ok`. Served assets matched the clean build:
`index-N_ivomFA.css` SHA-256 `4daaedf25bcedc70eb13943dbf4ca470d5d4d8a69e6bf58141812615abcd3143`,
`index-de-dDIFy.js` `c4b34c951e4baf543965e583a55046e1cde5a97e7547659730dcb7ea1cb920fa`,
and `home-n0ZxPWXa.js` `491a2d8262c9c4a260c00f44288f1824b65b9148573bc534b584dcc4e3e16721`.
Signed-in real Chrome showed the deployed Home at 390×844 and 1280×900 with
Booked Classes, favourite classes and Credits & passes visible, no horizontal
overflow and no console errors. Physical iOS standalone remains unverified.

## Home section surfaces and centred entitlement tiles — 2026-10-23

Before-change real Chrome at 390×844 showed transparent Home wrappers except
Credits & passes and Your activity. The credit tiles assigned four grid rows to
three direct children, while attendance assigned the same rows to two children;
the visible values therefore did not share a centred stack.

Decision: every `.home-widget` now owns the section surface: 16px padding and
radius with `color-mix(in srgb, var(--surface) 90%, var(--text) 10%)`. This is
darker than the page in light mode and lighter in dark mode, while the tiles
remain transparent and flat. Credits use `28px 1fr auto` for mark, centred
value/kind stack and detail. Attendance uses its matching two-child
`28px 1fr` grid with a centred number/unit stack. Existing membership and guest
pass content remains in the same markup and interaction route.

Checks: signed-in local Chrome at 390×844 in light and dark showed all seven
section wells and no document overflow. The value stacks were horizontally
centred within 0.004px. Dark wells resolved lighter than the `#090d16` page;
light wells resolved darker than the page. At 320×844, 402×874 and 1280×900,
all credit/activity tiles remained square (132px, 113px, and 129–202px), with
no tile or document overflow. Node 20.19.0 focused Home tests passed 35/35;
the client build passed with existing Vite mixed-import and over-500 kB chunk
warnings; `git diff --check` passed. The local fixture was restored to light
theme and its normal viewport. No deploy, commit, staging, live-gym write or
physical-iOS claim occurred.

## Booked Classes queue, tile contrast, and booking refresh — 2026-10-23

Before-change evidence: local Chrome at `http://127.0.0.1:5174/` rendered a
standalone `Auto-Book queue: 2 Pending` widget after Booked Classes, and source
selection returned `future.slice(0, 3)`. The booking-state reconciliation
updated `cache.bookings` but not Home's per-gym 120-second SWR booking rows, so
a Home repaint could read an older cached provider response.

Decision and progress: the queue is now a sub-row of Booked Classes, retaining
its own unavailable text and accessible button state; the separate registry
slot and flow placement are removed. Booked cards are capped at two. The
provider re-read writes the affected Home SWR row before emitting
`app-booking-state-changed`, and Home listens for that completed event. Home
well inline padding is 8px; local component color mixes distinguish entitlement
and favourite tiles without changing global surface tokens; the timetable CTA
is centred, capped at 250px, and retains its calendar icon with a visual arrow.

Verification: Node 20.19.0 focused Home, upcoming, and booking-state tests
passed (47 tests); the client build passed with existing Vite mixed-import and
over-500 kB warnings; `git diff --check` passed. In real Chrome against the
local mock, a successful JAB Quick-Book changed the Home header from one to
three total bookings while rendering only the first two cards; the new JAB card
was present immediately and `Auto-Book queue: 2 Pending` remained inside the
same Booked Classes section. At 320×844, 390×844 (light and dark), and
1280×900, document horizontal overflow was zero; widget inline widths were
304px/374px/435–653px and the full-timetable action measured 250px with its
calendar icon and arrow. Dark tile and well backgrounds resolved to distinct
local color mixes. The local mock and light theme were restored; no live-gym
write, deploy, commit, or physical-iOS verification occurred.

## Master integration inventory — 2026-10-23

This integration carries the approved Home screen implementation and its direct
dependencies: stable cached widgets and authenticated first paint; the bounded
PWA shell; Booked Classes day routing and queue refresh; favourites, credits,
activity and instructor presentation; Home-specific scroll state; provider
attendance, portrait enrichment and current rolling-weekly release data. It
excludes generated QA captures, fixture-priming scripts, the share-bookings
timezone change, and unrelated dirty-checkout artifacts. Final visual polish:
the Booked Classes queue has no top divider and the shared booking-card body
has a zero gap. Node 20.19.0 client tests passed 94 files / 710 tests; focused
profile-refresh, attendance, portrait, adapter, and class-history server suites
passed; the client build and `git diff --check` passed. Real Chrome rendered
this local worktree at 390×844 and 1280×900 with zero document overflow. The
local mock had no Booked Classes cards and its Booked Classes widget returned a
load error after the other Home sources completed, so the final queue divider
and shared-card gap were source- and test-verified rather than fixture-visible.
Merged-PR and branch-retirement details are recorded with the final integration
commit.
