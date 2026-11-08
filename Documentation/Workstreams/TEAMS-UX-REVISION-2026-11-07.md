# Teams UX revision — design and acceptance brief

2026-11-07. Design handoff only; no application implementation changed by this pass. This brief supersedes the previous pass where the latest owner feedback differs. Preserve the dirty `teams` worktree, its fixture scripts and unrelated changes. Do not restore whole files from Git. Development follows separately, then experimental deployment only; no commit, push, production or dev deployment.

## Evidence checked before design

The user's Google Chrome is reachable on CDP `127.0.0.1:9222` (Chrome 156.0.8078.80). An isolated tab reviewed the signed-in experimental build at `https://sweat-experiment.wingfield.tech/`, including a 402×874 mobile viewport. No booking, cancellation, payment, sharing or membership write was submitted. Gemini Flash made two successful retrieval/source-location calls; specific source/history claims below were checked directly. Two earlier delegate launches failed on incorrect progress-file paths before model invocation; the correct source is `PROGRESS-teams.md`.

- Current Team detail: Today and This week both use the new `tm-workout` grid. Today has lost its previous timeline layout; compact done rows have ticks. Upcoming JAB row is around 110px tall with gym/attendees below. [Team baseline](../QA/browser-runs/teams-ux-2026-11-07/design-revision/sol-design-team-mobile.png).
- `git show 62a620c:client/src/ui/teams-dashboard.js`, function `renderTodaysWorkouts`, contains the pre-pass Today design: upcoming time lead; class + location in the main title; attendee line beneath; a live progress ring and time range; completed gym circle/tick. Restore this renderer's visual structure selectively. Do not restore its lack of interaction/collapse or overwrite newer privacy fixes.
- `client/src/styles.css` near line 12891 applies `main.app-body:has(.app-settings-layout.show-pane) { padding-top:0!important }` without checking whether Settings is visible. After Settings → About → Home, Chrome reported `settingsDisplay:"none"`, selector match `true`, padding `0px`; the hidden layout retains `show-pane`. Thus the reported state leak has a verified source mechanism. Inspect scroll lock and header classes too; this review did not independently prove every unscrollable variant. [Home after nested Settings](../QA/browser-runs/teams-ux-2026-11-07/design-revision/sol-design-settings-leak-home.png).
- The class page currently renders `renderHomeFavouriteCard`, with an Edit action for the viewer's booked JAB class, and no attending-team-member list. `openTeamClass` in `teams-dashboard.js` owns this. [Current class page](../QA/browser-runs/teams-ux-2026-11-07/design-revision/sol-design-class-modal.png) was captured during its entrance transition, so use it as content evidence, not final-position evidence.
- About currently has eight feature cards and places the welcome tour last. Git `62a620c:client/index.html` has Welcome Tour first, What is this, credential/account explanation and Privacy & Data. Reuse the purpose; shorten the presentation. [Current About](../QA/browser-runs/teams-ux-2026-11-07/design-revision/sol-design-about-mobile.png).
- `cards.js` documents and implements `gymSquareChip(gymId)` as the small Settings gym plate, using `gymBrand(gymId,'half')`. Use this exact helper for weekly logos, rather than a circular filter mark or a newly drawn asset.
- The unwanted Bookings separator is `.ab-rail-toggle::after` (left:-8px, width:1px), not its border-left. Existing border-left override cannot remove it. Current unconditional mask rule near stylesheet line 12876 fades both ends of several scrollers regardless of overflow.
- `COPY.teams.queuedTag` is currently `trying for it`; the projection's underlying kind is `queued`. Manage's Captain branch currently renders requests, members, team settings, then My sharing. Its inline member list appends `captainsHelp`.

## Required design

### Settings navigation and scroll ownership — first priority

Keep the requested zero extra top padding inside a visible nested Settings pane. Make that state depend on the active route/panel, not a retained descendant anywhere in `main`. Prefer one explicit active-pane state owned by route activation and cleared on every departure; retaining the selected Settings section for return must not affect other routes. On departure, release Settings-only transforms, positioning, body/window overflow locks and header/padding state. Do not compensate by adding arbitrary padding to every destination.

Preserve per-route header spacing, reset the destination's correct scroll container, and keep Account reachable above bottom navigation from the root Settings menu. Verify tap navigation, browser back/forward and direct paths. Returning to Settings root first must cease to be a necessary workaround.

### Today and weekly classes

**Today:** restore the pre-pass timeline composition from `62a620c`, not the shared four-column workout grid. Upcoming rows: time at the left, class/location title beside it, attendees on the line below. Live rows retain the previous progress-ring treatment and time range. Do not add a dedicated right-hand instructor column to Today. Completed rows retain a clear tick, start collapsed with attendees hidden, and expand/collapse on tap with a short height/opacity animation. Aim for about half their expanded height (roughly 40–44px compact where content permits), preserving a 44px hit target. Empty/zero-done text stays hidden.

**This week:** a small rounded-square Settings gym plate at the left of the first row, followed by distinct time, class and instructor fields. Class is primary; instructor is quieter and bounded. Use `min-width:0`, bounded grid columns and ellipsis at narrow widths; do not let long names enlarge the page. No dotted separators. Attendees occupy the second row, indented to align after the gym plate, with initial avatars, names and shared spot circles in a horizontal strip. Target 68–80px for a normal two-row item; avoid a large fixed minimum height. Completed or already-started weekly rows have finished styling, a tick and no attendees until expanded, around half the expanded height. Earlier selected days follow the same rule. This is a display state; do not falsely claim attendance was confirmed. Today may still distinguish a live class with its progress ring.

Whole upcoming row/card opens the class page, including blank space, logo and attendee area. Horizontal swipes must scroll attendees without opening it; nested actions stop propagation. Do not nest buttons/links inside an outer button: use a semantic row with a primary keyboard-accessible control and delegated blank-area activation, ignoring interactive descendants and drags. Keyboard Enter/Space works. Whole completed row toggles expansion; an explicit View class action inside the expanded area can open details. Preserve expansion through minute/data refresh and update accessible `aria-expanded`/hidden state. Use reduced-motion preferences.

### Class page and statuses

Use the existing Teams page shell and modal-nav lifecycle, with a clear back/close control and an immediate route back to the same Team/selected day/scroll position. Put a **My Bookings-style class card** first: gym rail/identity, date/time, discipline/class name, location and instructor treatment from the app's established booking card. Do not keep the tiny Home favourite card or create a second booking policy.

The CTA comes from the timetable's existing action model for the exact `gymId:eventId`: Quick Book and alternate choose-a-spot when available, Book, Join waitlist, Auto-Book, existing-booking Edit, credit/access or disabled-gym action as appropriate. Match the timetable for the same event and viewer state. Never infer a write action from a teammate's booking or from stale Team metadata. If the event is unavailable, offer a useful timetable link scoped to that class/gym/date and safe loading/error state. Actions must remain usable when another sheet opens.

Under the class card, show **Team members** as readable member rows: initial avatar, first name/surname initial and accurate status; shared spot label only when the projection supplies it. Use `Booked`, `Waitlist`, and `Auto-Book` (or the established `Auto-book queue` label). Remove `trying for it`; it means a queued attempt, not a confirmed booking. Do not introduce new status semantics or expose private roster data. Do not draw teammate seats on a floor map from display labels: canonical slot IDs remain unavailable.

### Manage/sharing and membership

Order the Captain manage page as **Join requests → My sharing → Members → Team settings → Leave/delete**. Add a consistent 20–24px section gap between Join requests and My sharing/Members; avoid headings touching adjacent lists. Remove the displayed sentence `All Captains are equal. The Team always keeps at least one Captain.` Keep the server's last-Captain guard and its actionable error.

At **five total members or fewer**, keep the current inline management list. At **six or more**, replace it with a full-width `View all 6 members` row/button leading to a Teams-styled full members page using the same member row/list and Captain/removal actions. The threshold counts every member, including the viewer. Show no truncated inline duplicate. Refresh counts and preserve the route/scroll after an action. The new page inherits the current viewer's permissions: Captain actions stay Captain-only, with existing server authorization/last-Captain protection; do not accidentally offer them to regular members. Back/close returns to the same Manage page and scroll position, and stacked member/confirmation pages return to the full list without losing context.

Sharing retains the exact intro: “Choose which classes your Team can see. If they don’t use a gym, they won’t see its details.” All my gyms hides the gym list; Choose reveals it with a restrained animation. Retain Number of classes and remove the previously rejected explanations, Visible to team warnings and dotted goal divider.

### Bookings spots and overflow

Replace unconditional two-sided masks with state derived from the **specific scrollport**: overflow if `scrollWidth > clientWidth + 1`; left fade only if `scrollLeft > 1`; right fade only if `scrollLeft + clientWidth < scrollWidth - 1`. Normalize RTL if the component supports it. Update after render, resize, mutation/data refresh and scroll, with cleanup. A nonoverflowing strip has no fade. At the start only the right can fade; at the end only the left can fade.

Restrict the mask/overlay to spot/attendee content, with an 8–12px soft edge inside its own bounds. Keep Edit and the action rail outside it, crisp and fully clickable. Remove the actual `.ab-rail-toggle::after` separator in the requested booking context; preserve the `::before` enlarged hit area. Spots scroll horizontally only. Preserve open Edit/Auto-Book action rails through refresh.

### About and navigation icon

Keep About compact and use the same quiet surface, serif heading, sans body and line-icon language as Teams. Remove the tall marketing hero and eight-card feature catalogue. In order: **Welcome tour** card with existing replay button first; **About Dibs** with one concise purpose paragraph; **Privacy & data** with the original credential/account/delete purpose. A short expandable feature summary is optional, initially closed. No emoji. Do not rewrite a settings/help page as a landing page.

Suggested purpose: “Dibs brings your connected gyms, bookings and preferred spots together. Auto-Book tries when classes open, Auto-Upgrade watches for better spots, and Teams helps you plan with friends.” Preserve the independent-companion/studio-policy caveat in one quiet sentence. Privacy: “Your Dibs account is separate from your gym logins. Stored gym credentials are encrypted. You control what each Team can see and can delete your account and stored data from Account settings.” Link to existing settings destinations; avoid an unsupported claim that every stored field is encrypted.

Replace the current three-person Teams nav glyph with a clean **two-person shared-shoulder** line icon: two round heads with staggered height and a single coherent lower shoulder shape, 24px viewBox and the same 1.7–2px stroke as neighbouring nav icons. No mascot/glow or extra decoration. Preserve the Teams label and accessibility name. Preview beside Home, Timetable, Bookings and mobile account identity at actual navigation size.

## Preserve the already requested behavior

Keep list Team names wide and Captain top-right; referee creation mascot; timezone-aware sleep while any teammate class remains unfinished (including Eastern); liquid-glass shadow without glow; numeric in-class text plus tiny avatars on one line; Members' In class now pill; hidden Classes together; compact Home Teams without Captain/member/count/day tally and smaller mascot with emoji badge; finder above Teams hidden only by confirmed bookings; future Next up beyond today; detail retained on leaving/returning and Teams retap returns to list with breadcrumb animation; mobile-only name/initials and desktop Settings label; subtle header shadow, tighter mobile timetable and Bookings spacing. Do not regress these while selectively restoring Today/About.

## Acceptance before experimental redeploy

Development must run Node 22 `npm test` and `npm run build:client`, showing actual outputs; tests alone do not satisfy the browser matrix. Add meaningful regression coverage for route cleanup, status/action delegation, member threshold and overflow calculations as needed. Preserve all existing tests/fixture safety. Use the isolated dated mock generator/seed flow from `PROGRESS-teams.md`; do not modify real bookings for a visual check.

| Check | Required browser evidence |
|---|---|
| Settings exit | At 390/402px, open About, General, Privacy and a gym pane; go directly to Home, Timetable, Bookings and Teams. No clipped top; destination scrolls fully; Account reachable; repeat via back/forward and root back. Capture computed route/padding/scroll state plus screenshots. |
| Today restoration | Compare new Today against `62a620c` structure; upcoming/live/done fixture; no forced instructor column; completed tick and expansion, zero-done hidden. |
| Weekly | Future, currently started and previous-day rows; correct Settings logo assets; long names at 320/390/402px; shorter two-row items; compact/expanded completed states and swipe without accidental open. |
| Class page | Tap logo, attendee area and blank row space; booking-card treatment and member rows. Match timetable CTA for booked, open, full/waitlist, unreleased/Auto-Book, insufficient credits, disabled gym and missing event. Test dismissal/return without submitting live writes. |
| Manage | Five-member inline and six-member button fixtures, same full list/actions on dedicated page; correct section order/space and removed Captain explanation. |
| Overflow/Edit | Zero-overflow, start/middle/end states with many spots; fades only at hidden-content edges; crisp Edit; no separator; horizontal only; rails remain open after refresh. |
| About/icon | Tour visible first; concise purpose/privacy; no emoji/feature wall; new icon beside neighbours; mobile account and desktop Settings preserved. |
| Regression/surface | Home confirmed-booking and waitlist-only variants; Team return/retap; live/Eastern sleep; sharing All/Choose; mobile and desktop light/dark. Record unsupported physical iOS/PWA checks honestly. |

After local checks, deploy **experiment only** under the selfhost-deploy skill, update its registry in the same turn, verify container/health and deployed asset identity, clear the prescribed client caches, and repeat the key browser checks against the deployed experiment. Report remaining acceptance gaps, not a blanket completion claim.
