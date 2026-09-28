# U1 — UX bug fixes from QA

**Priority:** P1–P2 · **Size:** ~1 day · **Depends on:** nothing · **Nice before:** C4

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Cheap, visible fixes. Run them alongside C3 so they share the same live re-test.

| # | Item | Status | Est. |
|---|---|---|---|
| U1-1 | **"Spot ?" on FCFS bookings.** | ✅ Fixed 2026-09-27; dev-twin re-test 2026-09-27: no FCFS booking existed on the real account — not exercised (see below) | 30 min |
| U1-2 | **About pane lists every linked gym.** | ✅ Already done (C3-6) — verified 2026-09-27 | 1 h |
| U1-3 | **Debug terminal toggles live.** | ✅ Fixed 2026-09-27; re-confirmed live on dev twin 2026-09-27 | 15 min |
| U1-4 | **Recover-screen copy.** | ✅ Already done (C1-4) — verified 2026-09-27; re-confirmed live on dev twin 2026-09-27 | 15 min |
| U1-5 | **Toast dismiss button.** | ✅ Fixed 2026-09-27; re-confirmed live on dev twin 2026-09-27 | 1 h |
| U1-6 | **Auto-book overlap confirmation modal.** Overlap only produced a fleeting toast (C5-3, `c3b4d08`). *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28; live dev-twin test is the user's | 1 d |
| U1-7 | **Settings → Your Gyms renders incrementally and sometimes duplicates.** *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 | 2 h |
| U1-8 | **1:1 gym logo chip on each per-gym Settings submenu item.** *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 | 1 h |
| U1-9 | **"Last authenticated" always says "Not recorded".** README "Verified done" (QA-07) claims it works. *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 (write bug) | 1 h |
| U1-10 | **Icons on Settings menu items** (SVG, not emoji). *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 | 1 h |
| U1-11 | **Strip the discipline prefix from class names.** JAB's `TRAIN - Upper (Focus)` should display as `Upper (Focus)`, because the discipline pill already says TRAIN. `cleanClassName` doesn't handle the `DISCIPLINE - Name` pattern. Found by the user 2026-09-29. ✅ **Fixed 2026-09-29** (see below). | `client/src/ui/cards.js cleanClassName` | 30 min |
| U1-12 | **Overlap modal for Book and Quick-Book too**, not only Auto-Book. It must precede any other modal (spot picker, first-time setup). Found by the user 2026-09-29. ✅ **Fixed 2026-09-29** (see below). | U1-6 `overlap-modal.js`; `timetable.js` book/quick-book | 2–3 h |
| U1-13 | **Auto-Book card shows "Insufficient Credits" despite sufficient credits** (live, the user's configured Psycle auto-book; they can book another open class). Found by the user 2026-09-29. ✅ **Fixed 2026-09-29** (see below). | `client/src/ui/autobook.js`, credit-allowance | 1–2 h |
| U1-14 | **First-time spot-map setup intro, and allow occupied spots while setting up.** When Quick-Book or Auto-Book hits a studio with a gym-provided seat map but no saved preferred map, open an intro step first: header "First-time setup", subheader "Choose your preferred spots for [Gym] [Studio location] first.", and body "Once set up, <b>Quick-Book</b> and <b>Auto-Book</b> will always book the best possible spot for you." A Next button swaps in the map. In setup mode, occupied spots must be selectable: you're choosing preferences, not a bike for this class. Today it refuses with "⚠ This bike is occupied or unavailable." Found by the user 2026-09-29. ✅ **Fixed 2026-09-29** (see below). | `timetable.js openBookingModal`/`quickBookClass`, `spotmap.js` | 2–3 h |
| U1-15 | **Timetable shows a class as booked for several seconds after cancelling it in My Bookings.** A booking/cancel mutation must invalidate the timetable's booking-state overlay so returning to the timetable reflects it immediately. Found by the user 2026-09-29. ✅ **Fixed 2026-09-29** (see below). | `timetable.js` booking overlay/cache; `bookings.js` cancel | 1–2 h |
| U1-16 | **Psycle push notifications read "CLASS with your instructor - Spot …".** The class name and instructor are missing for Psycle; JAB is fine. Probably a regression from C3-19 (the booking-success payload now carries gymId) or from the normalized field names. Found by the user 2026-09-29. ✅ **Fixed 2026-09-29** (see below). | `server/notifications.js`; `client/src/api.js notifyBookingSuccess` callers | 1 h |
| U1-17 | **Calendar event titles don't strip the discipline prefix.** `server/calendar.js` has its own class-name cleaner, separate from the client's `cleanClassName` (U1-11), so JAB titles may read `JAB: TRAIN - Upper (Focus)…`. Share one rule between client and server (one lookup per fact). Noticed by the U1-11 agent on 2026-09-29; not yet verified. | `server/calendar.js` name cleaner | 1 h |
| U1-18 | **Timetable rendered empty on the first live load after a deploy.** A second load showed 153 rows. It may be a cold provider cache (C4 notes about 22 s cold) racing a render that treats "no data yet" as "no classes". If so, that's a "not loaded ≠ empty" bug; show a skeleton instead. Seen by the U1-11..16 agent's live smoke on 2026-09-29; not reproduced. Relates to U4-7. | `timetable.js` first render / prefetch | 1–2 h to investigate |

## Dev-twin re-test (2026-09-27)

Deployed HEAD `2952eec` to `sweat-dev.wingfield.tech`, re-tested against the real two-gym
account (`test@piersj.com`, Psycle + JAB), CDP :9222 real Chrome, one dedicated tab, all three
client caches cleared first.

- **U1-3:** toggled `#psycle-setting-debug-mode` on in Settings → General — `#psycle-debug-terminal`
  went to `display: block` immediately (`getComputedStyle`, no other action needed). Toggled off —
  went to `display: none` immediately. Restored to its original (off) state afterward.
- **U1-5:** toggling the same setting fires a real "Settings saved successfully." toast;
  captured it in the DOM within 200ms of the change event — `class="psycle-toast success show"`,
  contains a `<button class="toast-close" aria-label="Dismiss notification">×</button>`. Confirmed
  present and correctly labelled; a later click attempt landed after the toast's own 3.5s auto-hide
  had already cleared it (non-error toasts still auto-hide by design), so the click-to-dismiss
  interaction itself wasn't re-captured this pass, but the button's presence/label is the
  concrete regression this item existed to fix.
- **U1-1:** the real account's My Bookings only holds two JAB bookings right now — one
  pick-a-spot TRAIN booking with a real assigned spot ("SPOT 2") and one waitlisted entry —
  no FCFS/no-map booking exists to show the "Open floor" chip on. Per the task's own
  instruction ("don't create one"), this was **not exercised live**; the fix's local-mock
  browser evidence above stands as the verification.
- **C7-1 (shared re-test, tracked in C3):** 62 sequential `/api/*` calls across a full 5-tab
  sweep, all 200, zero 429s.

---

## U1-1 — "Spot ?" on FCFS bookings

**Root cause (2026-09-27):** `buildBookingCard()`'s chip renderer
(`client/src/ui/bookings.js`) computed
`slotLabel = b.raw?.spot?.name ?? b.studio_slot?.label ?? b.slot ?? b.studio_slot_id ?? b.slot_id ?? slotId ?? '?'`.
For an FCFS/Recovery booking the normalized booking's `slotId` is the empty
string `""` (confirmed via `GET /api/bookings` on the JAB mock — the response
carries `"slotId": ""`), not `null`/`undefined`. `??` only falls through on
nullish values, so the chain stopped at `""` and never reached the `'?'`
literal — the chip rendered as a blank "SPOT" pill, not even the literal `?`
the ticket described. Worse, it was still a `<button>` wired to open the
auto-upgrade config modal for a class that has no seats to upgrade between.

**Fix:** `client/src/ui/bookings.js` ~L191–241. Resolved `hasMap` (from the
existing `getStudioMapInfo()`, already used one line below for the Edit-button
gating) before building the chips, and render a non-interactive
`<span class="ab-spot-open-floor">Open floor</span>` badge instead of the
upgrade-config button whenever `!hasMap`. CSS added at
`client/src/styles.css` (new `.ab-spot-open-floor` rule, next to the existing
`.ab-spot-upgrade-chip` rules) — same pill shape, muted `--text-secondary`
colour, `cursor: default`, no hover state.

**Scope check:** grepped for the same `?? '?'` fallback pattern and for
`slot_label`/`slotLabel` handling elsewhere (calendar feed, notifications,
auto-book/auto-upgrade rows). `server/calendar.js` already guards this
correctly (`b.slot != null ? String(b.slot) : ''`, and filters empty labels
out of the joined seat list) — no other surface reproduces the bug, so
nothing else was touched.

**Before (browser, JAB mock, `dev@psycle.com` + linked `dev@jabboxing.mock`,
JAB Recovery "Members" 13:00 booked via Quick-Book):** My Bookings chip
rendered as `SPOT` (blank slot label, `data-slot-label=""`), still a
clickable button wired to `handleUpgradeClick()`.

**After:** chip renders as a static `OPEN FLOOR` badge
(`<span class="ab-spot-open-floor" title="First come, first served — no
assigned spot">Open floor</span>`), not in `.ab-spot-upgrade-chip`'s
click-listener selector, so it has no click handler. Other bookings'
real spot labels (`Bike 27`, `Spot 11`) unaffected.

---

## U1-2 — About pane lists every linked gym

**Not reproduced — already fixed by C3-6.** `client/src/gym-context.js`
L71–77 `applyGymNames()` joins every linked gym's `shortName` (`names.join('
and ')` for 2+ gyms), not the single ambient gym C3-6's commit message
describes replacing.

**Browser evidence (2026-09-27):** logged in as `dev@psycle.com` with both
`Psycle London` and `JAB Boxing Club` linked (pre-existing dev-mode link).
Settings → About renders: *"Sweat Assistant — an unofficial companion for
JAB and Psycle, built for personal use."* — both gym names present. No code
change made for this item.

---

## U1-3 — Debug terminal toggles live

**Root cause (2026-09-27):** `updateDebugTerminalVisibility()`
(`client/src/main.js` L217) is only called once, at app init
(`client/src/main.js` L1007). `setupSettingsListeners()`'s `saveSettings()`
in `client/src/ui/settings.js` (~L1808–1826) updates `userSettings.debugMode`
and calls `updateTestNotifCardVisibility()` but never
`updateDebugTerminalVisibility()`. The terminal *looked* like it reacted
sometimes because `debugLog()` itself does `terminal.style.display =
'block'` as a side effect of logging — so toggling debug mode ON and then
triggering any network call (switching tabs, etc.) made it appear, papering
over the missing call. Toggling OFF has no equivalent side effect, so the
terminal stayed visible indefinitely.

**Fix:** `client/src/ui/settings.js` — imported `updateDebugTerminalVisibility`
from `../main` and call it in `saveSettings()` right after
`updateTestNotifCardVisibility()`.

**Before (browser, Settings → General → Debug Mode):** toggled ON — toast
"Settings saved successfully", terminal still `display: none`
(confirmed via `getComputedStyle`). Toggled OFF while terminal was visible
(from an incidental `debugLog()` call) — toast saved, terminal still
visible, persisted across a tab switch.

**After:** toggling ON shows the empty terminal immediately, no other action
needed. Toggling OFF hides it immediately.

---

## U1-4 — Recover-screen copy

**Not reproduced — already fixed by C1-4.** `client/src/main.js` L1281:
`recover:{ title: 'Reset password', subtitle: 'Self-service reset isn't
available yet — contact the admin.' }`. No mention of gym sign-in.

**Browser evidence (2026-09-27):** logged out, clicked "Forgot password?" —
card renders "Reset password / Self-service reset isn't available yet —
contact the admin." with only an email field, "Continue" and "Back to log
in". No gym-picker step, no gym-login copy. No code change made for this
item.

---

## U1-5 — Toast dismiss button

**Root cause (2026-09-27, confirmed by reading `showToast()`,
`client/src/main.js` L132–169):** toasts had no close control at all and
every variant (including `error`) auto-removed itself after a fixed 3500 ms
timer — an error toast a user looked away from for a few seconds was gone,
with no way to reread it, and no way to speed-dismiss an info/success toast
either.

**Fix:** `client/src/main.js` `showToast()` (~L132–178):
- Added a `<button class="toast-close" aria-label="Dismiss notification">×</button>`
  appended alongside the icon/message. A native `<button>` is keyboard
  reachable (Tab) and activatable (Enter/Space) with no extra wiring.
- `error` toasts no longer get an auto-hide timer — only `dismiss()` (the
  close button) removes them. All other variants keep the 3.5 s timer, which
  the close button can also short-circuit early (`clearTimeout`).
- `role`/`aria-live` behaviour unchanged (`alert`/`assertive` for errors,
  `status`/`polite` otherwise).

CSS: `client/src/styles.css`, next to the `.psycle-toast` rules — gave the
toast a `flex` layout (icon / message / close button), and styled
`.toast-close` with `color: inherit` so it follows each variant's own text
colour (works for success/error/info's near-white text, warning's dark
text, and the catch-all's `--text`) rather than needing a rule per variant.

**Before (browser):** `showToast('...', 'error')` — toast appeared with icon
and message only, no close affordance, gone after ~3.5 s regardless of type.

**After (light theme):** error/warning/success/info toasts all show a
visible `×` button; clicking it removes the toast immediately
(`Settings saved successfully.` dismissed on click). An error toast
(`showToast('Something failed badly', 'error')`) left on screen unattended
for 5+ seconds (past the old 3.5 s cutoff) remained visible until the close
button was clicked. **Dark theme:** re-checked with `psycleTheme=dark` —
error/warning/success toasts all render with a legible `×` against their
respective backgrounds (screenshot: red/amber/green pills each with a clear
close glyph).

---

## U1-6 … U1-10 — Settings and auto-book UX (2026-09-28, source: user dev-twin testing)

Five items from the user's dev-twin testing session. Each entry below records the
root cause **before** the fix, per [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

### U1-9 — "Last authenticated" always says "Not recorded"

**Root cause: a WRITE bug, not a read or render bug** (2026-09-28).

- Read-only check on the dev twin (`ssh oracle`, `docker exec -w /app/server psycle-app-dev`
  with `better-sqlite3` opened `readonly`): the test account's two links
  (`user_id=2`) both had `last_authenticated_at = NULL`, and across the whole table
  **0 of 677** `user_gyms` rows had a value. Nothing was modified.
- The read path was always correct: `db.getUserGymsPublic()` selects the column,
  `GET /api/my-gyms` returns it, and `settings.js lastAuthLabel(g.last_authenticated_at)`
  reads the right field name. It faithfully rendered NULL as "Not recorded".
- The column was never written. `db.upsertUserGym()` listed its columns explicitly in
  both the `INSERT` and the `ON CONFLICT ... DO UPDATE`, and `last_authenticated_at`
  was in neither, so `setGymSession()` and `auth.linkGymAccount()` (which do pass it)
  had it silently dropped. The two writers the ordinary login uses
  (`updateUserCredentials`, `updateUserJWT`, via `auth.handleLogin`) never passed it.
  So QA-07's "written on session issue" was true of the call sites and false of the
  database. Reproduced on the local mock: a fresh `dev@psycle.com` login left both
  gyms' `last_authenticated_at` `null` in `GET /api/my-gyms`.

**Fix:** `server/db.js` `upsertUserGym()` now persists the column (defaulted to NULL
in `merged`, so an unrelated upsert preserves it), and `updateUserCredentials` /
`updateUserJWT` stamp it when a session is actually issued. `setGymSession` (background
and auto-relogin renewals) and `linkGymAccount` already passed it; they now work.
Clearing a session (a failed renewal) deliberately does not stamp.

**Test:** `server/test-last-authenticated.js` (db write paths, then the whole path over
HTTP: login and gym-link each surface a recent timestamp on `GET /api/my-gyms`).
Failed first for the recorded reason (`upsertUserGym` returned `null`).

**Known limit:** existing links carry NULL and stay "Not recorded" until the next
login, re-authenticate or background session renewal. There is no honest source to
backfill from, so none was invented.

### U1-7 — Your Gyms renders incrementally and sometimes duplicates

**Root cause (2026-09-28), two faults in `renderGymsCard()` (`client/src/ui/settings.js`):**

1. **Incremental.** The sidebar entries were built only after `await api.getMyGyms()` **and**
   `await api.getGyms()`, and then one gym at a time with `await renderGymSettingsSection()`
   (a settings + membership + credits fetch) *between* iterations. Gym 1's entry appeared,
   gym 2's appeared after gym 1's section had loaded. The gym list was already known at boot
   (`loadGymContext()` runs before Settings binds) and was not used.
2. **Duplicates.** The render cleared every `[data-gym-nav]` entry and pane, then appended in
   that awaiting loop. Two overlapping renders interleave: B clears A's half-built menu, A
   resumes and appends the gyms it hadn't reached, B appends its own, so a gym is listed twice
   with two panes sharing one `id`. Renders overlap because `initSettings()` starts one at
   boot and others start from the `psycle-gym-needs-relogin` event (which a stale JAB session
   fires during boot), a re-link and an unlink.

**Browser evidence before (local mock, both gyms linked, CDP :9222; a MutationObserver
logged `navEntries/panes/tableRows` over time, network latency 200 ms):**

- Incremental: `0/0/0 → 0/0/2 (t=279ms) → 1/1/2 (t=490) → 2/2/2 (t=1115) → 1/1/2 → 2/2/2`.
  The table appeared first, the gym entries one at a time, then the whole menu was torn down
  and rebuilt (`2 → 1 → 2`) by the second render.
- Duplicate, reproduced deterministically by firing the needs-relogin event as soon as the
  first entry appeared (`3/3/2`; menu read
  `… Your Gyms | JAB Boxing Club | Psycle London | Psycle London | About`, three panes).
- Screenshots: `before71-{light,dark}-{desktop,mobile}-menu.jpg` in the scratchpad.

**Fix (not a delay):** new `client/src/ui/gym-connections.js`.
- `reconcileKeyed()`: entries, panes and table rows are **keyed by gym id and updated in
  place**, in order, before the "About" anchor. Rendering is idempotent, so running it twice
  (or six times concurrently) cannot create a second copy; a surviving element keeps its
  `.active` class and loaded pane content; any duplicate key already in the DOM is collapsed.
- `createRenderGuard()`: each render takes a generation token, and a superseded render stops
  at its next `await` rather than writing stale data over a newer one.
- `renderGymsCard()` now paints **synchronously** from `getLinkedGyms()` (the boot context),
  then enriches the same elements from `GET /api/my-gyms` (health, last authenticated), then
  fills each gym's pane. Click handling is one delegated listener bound once, so persistent
  rows need no re-binding. `renderGymSettingsSection()` no longer flashes "Loading…" over a
  pane that already has content.

**Tests:** `client/src/ui/gym-connections.test.js` (vitest): keyed reconcile (identity kept,
in-place update, removal, reorder, duplicate collapse), the guard, and a simulation of the
overlap showing the old clear-then-append shape duplicates while the keyed render never does
at any offset between two renders.

**After (same harness):** `0/0/0 → 2/2/2` in a single step (t≈85 ms at 0 latency, at the
same moment the rest of the app paints), 3 hard refreshes at 0 ms and 4 overlap-kick
offsets at 200 ms latency: always 2/2/2. Six `renderGymsCard()` calls launched 90 ms apart
under 150 ms latency: 2 entries, 2 panes, 2 rows, unique pane ids, both panes populated.
Unlink → nav 1/1/1 and pane removed; relink through the modal → 2/2/2 with the new row filled
in (`Today · 28 Sept 2026`, also U1-9 end to end).

### U1-10 — Icons on Settings menu items

**Basis (2026-09-28, browser):** the five static Settings entries (`client/index.html`
`.psycle-settings-menu`) were text only (`before71-*-menu.jpg`); no icon existed for any of them.

**Fix:** `client/src/ui/cards.js` gains five glyphs in the shared `SVG_PATHS` set (`sliders`
General, `bell` Notifications, `user` Account, `link` Your Gyms, `info` About), drawn on the
same 16px grid and rendered by the same `icon()` helper (1.6 stroke, round caps,
`currentColor`, `aria-hidden="true"`), so they follow the active/hover colours for free.
`settings.js decorateSettingsMenu()` prepends one to each entry at init (idempotent; injected
from the shared set rather than pasted as five more hand-written SVGs in `index.html`). CSS in
`styles.css` sits after the `-sub` rules because source order decides ties here (AGENTS.md,
~L5222 vs ~L8356 note); on the mobile list the label takes the slack (`flex: 1`) so it stays
left-aligned between the icon and the chevron.

**After (browser, local mock):** `after810-{light,dark}-desktop-menu.jpg` and
`after810-{light,dark}-mobile-menu.jpg` (402pt). Icons are 20px in a 28px box, colour follows
`--text-secondary` / `--accent` when active, legible in both themes.

### U1-8 — 1:1 gym logo chip on the per-gym Settings entries

**Basis (2026-09-28, browser):** the per-gym sidebar entries ("JAB Boxing Club",
"Psycle London") were text only (`before71-*-menu.jpg`). No square asset exists
(`client/public/gyms/` holds only the two Psycle wordmarks; JAB's is inline SVG), and the
two existing gym shapes are the wide table plate (`gymChip`) and the tall card rail
(`renderGymRail`).

**Fix:** `cards.js gymSquareChip(gymId)`, a third shape from the **same** `gymBrand()`
asset: a 28px square, brand plate colour behind the wordmark (`#212121` Psycle, `#6C1F20`
JAB, same values as `.psycle-gym-chip-*`), Psycle always on its half mark, decorative
(`aria-hidden`; the gym name is beside it), with a 1px ring so the near-black plate stays
visible in the dark theme. `settings.js gymNavCreate/Update` puts it in a
`.menu-item-lead` slot where the static entries have their icon (U1-10), so gym entries and
icon entries align. Reconciled with U1-7: the mark is only rebuilt if the gym id changes.

**After (browser, local mock):** `after810-*-{desktop,mobile}-menu.jpg` show both gyms with their
plate in light and dark, desktop sidebar and 402pt mobile list. Test:
`client/src/ui/gym-mark.test.js`.

### U1-6 — Auto-book overlap confirmation modal

**Basis (2026-09-28, code + browser).** `saveAutoBookPreferences()` (`client/src/ui/timetable.js`)
called `api.addAutoBooking()`, which inserted the row first; the server then returned
`warnings[]` and the client fired one `showToast(w.message, 'warning')` per warning. Reproduced
in the local mock (real Chrome, CDP): queue Psycle #1225 (Barre Express, Fri 9 Oct 13:15), then
Auto-Book JAB #9113 (TRAIN, same time) from the timetable: the client showed
"Successfully scheduled auto-book for TRAIN - Full Body Conditioning!" and then an amber
toast "Overlaps another queued class: Barre Express 30 at Psycle, Fri 9 Oct 13:15.", which
auto-hides after 3.5 s; both rows were already in the queue (`[[jab 9113,[OVERLAP_QUEUED]],
[psycle 1225,[OVERLAP_QUEUED]]]`). So the member is told after the fact, briefly, with no way to
back out.

**Design choice: (a), a server-enforced confirm flag, not client-side detection.**
- `POST /api/auto-book` runs the existing detector (`server/competing-bookings.js`, still the
  single source of truth for the overlap rule). If the class overlaps a queued class or a booking
  (any gym) and the body lacks `confirmOverlap: true`, it answers **409
  `OVERLAP_CONFIRM_REQUIRED`** with `warnings[]` and **inserts nothing** and does not re-arm the
  scheduler. Resubmitting the same body with `confirmOverlap: true` queues it as before, warnings
  included.
- An **exact duplicate stays a hard 409 `DUPLICATE_AUTO_BOOK`**, checked first, and cannot be
  overridden by the flag. The client shows its message ("This class is already in your
  auto-book queue.") in an error toast, which is now sticky until dismissed (U1-5).
- Why not a separate dry-run endpoint: it is two requests that can disagree (queue changes
  between check and commit) and a second contract to keep in step; the flag makes the one POST
  self-checking and is race-free (check and insert are the same synchronous handler).
- Why not (b): a client-side overlap check would need the queue, the bookings and each gym's
  timezone rules (CodexFit serves naive datetimes) on the client, a second copy of the rule.
  The client only renders what the server reports.
- Each warning's `with` reference now carries display fields (`groupName`, `instructorName`,
  `instructorImageUrl`, `locationName`, `studioName`, `durationMin`) so the modal can draw the
  other class from the server's own row, no extra lookup; null where the source never had it
  (`booking_cache` stores no instructor photo, so a booked clash falls back to the by-name lookup
  in `instructorAvatar`).
- Contract change: any other caller of `POST /api/auto-book` must send `confirmOverlap: true` to
  queue an overlap. The only client caller is `saveAutoBookPreferences`; the only test caller is
  `test-competing-bookings.js`, updated. A stale cached client (old service-worker bundle) would
  get the 409 and show its message in an error toast rather than silently queueing.

**Client:** `client/src/ui/overlap-modal.js` (`confirmOverlap()` -> `Promise<boolean>`).
- Shell: the shared `.psycle-modal` / overlay / card / header / body pattern of every dialog in
  `index.html`, built on demand; U2-1's shared modal component was **not** built.
- Content: a short warning line (from the warning codes), the new class and the clashing
  class(es) as **stacked cards using the Auto-Book queue card** (`psycle-autobook-card ab-card`:
  `renderGymRail` logo + location, `disciplineTag`, `cleanClassName`, `instructorAvatar` photo
  + name, `escapeHtml` on every interpolated string). At most 3 clashes are shown, then "and N
  more". Actions: **Auto-book anyway** / **Cancel**.
- Accessibility: `role="dialog" aria-modal="true"` with `aria-labelledby`/`aria-describedby`;
  focus moves in on open, onto Cancel (the safe choice); Tab wraps at both ends; Esc, Cancel,
  the close button and the backdrop all cancel; the Esc handler is capture-phase and stops
  propagation so it cannot also close the config modal underneath; focus returns to the trigger
  on close; only one dialog at a time (a double-tap shares the open one).
- `saveAutoBookPreferences`: on 409 `OVERLAP_CONFIRM_REQUIRED`, await the modal; **Cancel leaves
  the config modal open and nothing queued**; **Auto-book anyway** resubmits with
  `confirmOverlap: true` and then does the normal success path. The per-warning toasts are gone.
  `api.addAutoBooking` now throws an `Error` carrying `.status`, `.code`, `.warnings`.
- CSS: `.psycle-overlap-*` in `styles.css` next to `.ab-clash-warning`. The card composites
  `--surface` over `--bg` because `--surface` is translucent in the dark theme and this dialog
  opens on top of another modal (the first dark screenshot showed the spot map bleeding through).

**Mock support (documented as asked):** the JAB mock had no unreleased class, so JAB Auto-Book
was unreachable in dev (the Psycle mock already has them past its 7-day cutoff). `server/mock-
marianatek.js`: days 11-13 of the 14-day schedule now publish
`booking_start_datetime = start - 10 days` (MarianaTek's rolling-continuous shape), so they show
Auto-Book. Days 0-10 stay open on purpose: `test-background-gym-session.js` books #9100 (day 10).
On day 11 the JAB and Psycle mocks both run 12:15, 17:30 and 18:30 classes, which is what the
overlap scenario uses.

**Tests:**
- `server/test-competing-bookings.js` (updated): unconfirmed overlap -> 409 `OVERLAP_CONFIRM_REQUIRED`
  and the queue is unchanged; `warnings[].with` exposes the display fields, including the stored
  instructor/photo/location; `confirmOverlap: true` queues it with the warning; the flag cannot
  override a duplicate; the JAB mock's rolling window.
- `client/src/ui/overlap-modal.test.js` (vitest/jsdom): warning-code copy, the shared card markup,
  HTML escaping, dialog roles, focus in/out, confirm/cancel/close/backdrop, Esc not reaching the
  layer beneath, Tab wrapping, one-at-a-time.

**Browser evidence (real Chrome, CDP, local mock):**
- Before: `before6-light-desktop-page.jpg` (success toast + sticky-less warning toast; both rows queued).
- After (`after6-{light,dark}-{desktop,mobile}-modal.jpg`, mobile = 402pt; `after6img-*` shows the
  instructor photo path): clicking Auto-Book on JAB #9113 opens the modal with the JAB card over
  the Psycle "In your queue" card; the queue still holds only the Psycle entry.
  Driven end to end: Esc closes only this modal (config modal stays open) and focus returns to
  "Schedule Auto-Book"; Cancel and backdrop likewise leave the queue at 1; Auto-book anyway closes
  both modals and the queue holds both rows (each flagged `OVERLAP_QUEUED`); an exact duplicate
  is a 409 `DUPLICATE_AUTO_BOOK` with no modal.
- Method note: Chrome gives a background tab no trusted key events (`visibilityState:
  hidden`), so Esc and Tab-wrapping were driven with synthetic `KeyboardEvent`s, which exercise
  the modal's own handlers but not the browser's default Tab order (covered by the jsdom test).

### U1-6 … U1-10: dev-twin deploy and live smoke (2026-09-28)

Deployed HEAD `b5bedf0` to `sweat-dev.wingfield.tech` only (`./deploy.sh`, no `--prod`); rollback
image `psycleapp-dev-psycle-app:rollback-u1-20260928`, pre-deploy snapshot
`psycle-20260928-230425.db.gz`. `docker ps`: `psycle-app-dev` Up on `100.86.226.52:3005->3000`,
prod `psycle-app` unchanged (`Up 8 weeks`). `/api/health` 200 via the tailnet address.

Live read-only smoke, real Chrome (CDP), one tab, `test@piersj.com`, SW + CacheStorage + the
IndexedDB cache cleared first (session kept):
- **U1-7:** three hard refreshes of `#settings`: the sidebar entries, panes and connection rows go
  `0/0/0 -> 2/2/2` in a single step (105, 72, 68 ms after document start), menu reads
  `General | Notifications | Account | Your Gyms | JAB Boxing Club | Psycle London | About`, no duplicate.
- **U1-8 / U1-10:** 5 icons on the static entries, 2 gym marks (`psycle-gym-mark-jab-boxing`,
  `-psycle-london`), rendered as in `live-dev-desktop-menu.jpg`.
- **U1-9: shows "Not recorded" live, as expected.** The fix records the stamp at the next login,
  link, re-authenticate or background session renewal; neither existing link has had one since the
  deploy, and no honest source exists to backfill from. One "Re-authenticate" on each gym (or the
  next renewal) will populate it. The local end-to-end check (`after9-light-desktop-gyms.jpg`)
  shows `Today · 28 Sept 2026` for both gyms after a login.
- **U1-6** not exercised live by design (no auto-books on the live twin); the user tests it.

---

## U1-16 — Psycle push reads "CLASS with your instructor - Spot …"

**Root cause (2026-09-29, confirmed against the local mock):** `quickBookClass` built its
`notifyBookingSuccess` payload from `eventData = event.raw`. For Psycle `.raw` is the CodexFit
event; `GET /api/events/1000` (psycle-london) returns raw keys
`capacity, duration, event_type, event_type_id, id, instructor, instructor_id, occupancy, start_at, studio, studio_id`, so
`raw.name`, `raw.discipline`, `raw.instructors` and `raw.startAt` are all `undefined`. The server
received no class, group, instructor or start time, and `groupToken`/`firstName` fell back to
`CLASS` / `your instructor`. JAB's raw carries those names, which is why only Psycle broke. (The
normalized event has them: `name: 'Ride 45', discipline: 'Ride', instructors: [{name: 'Adam'}]`.)

**Fix:** new `client/src/ui/booking-notify.js` `bookingNotifyPayload(event, …)` reads the
normalized event; both quick-book call sites in `timetable.js` (~L2354, ~L2441) use it, and the
seat noun reads `event.discipline`. Server: `notifications.js withInstructor()` drops the
"with …" clause when there is no instructor (no more "with your instructor"), used by all five
builders (shared with C3-29's rule).

**Tests:** `client/src/ui/booking-notify.test.js` (Psycle raw-without-names shape, JAB shape, empty);
`server/test-notification-text.js` (both gyms, no-instructor for every builder, no double space).

## U1-11 — Discipline prefix on class names

**Root cause (2026-09-29):** MarianaTek's `discipline` is `class_type.name` (`providers/marianatek.js:608`),
which for JAB is the FULL class name ("TRAIN - Upper (Focus)"). `cleanClassName(name, discipline)` built its
prefix regex from that whole string and required a separator after it, so it never matched. The pill
shows "Train" because `getDiscipline()` maps the text to a label. The pre-fix vitest cases below fail
against the old code (2 of 5). A second, weaker copy, `stripClassNamePrefix` (My Bookings), had the same hole,
and Auto-Book/Auto-Upgrade cards printed the raw DB `class_name` with no cleaning at all.

**Fix:** `client/src/ui/cards.js cleanClassName` (~L360) now tries the discipline, its head before a
`:`/`-`/`–` separator, and the pill label (`getDiscipline(...).label`), longest first; only a prefix
that IS the discipline is stripped, so "Upper - Lower Split" under TRAIN is untouched.
`stripClassNamePrefix` delegates to it (one rule); `autobook.js` (queue + history cards) and
`autoupgrade.js` use it too. **Tests:** `client/src/ui/cards.test.js` (JAB, Psycle, non-stripping, no-blank cases).

## U1-13 — Auto-Book card "Insufficient Credits" despite holding credit

**Live read-only evidence (2026-09-29, sweat-dev, `test@piersj.com`, my own CDP tab, 6 GETs):**
`GET /api/auto-book` (psycle-london) returns the queued class (id 126 "Strength 50", Reformer,
14 Oct) with `status: "pending"`, `requiredCount: 1`, `warnings: []`: the server has not paused or flagged it
(no `paused_no_credits`). `GET /api/credits` returns one `Universal` credit, `count: 1, isGuestOnly: false`;
`GET /api/eligibility` returns `canBook: true`. On a fresh load the card now shows **no** warning. So the server
data was right and the card decision was wrong: it fires only from `autobook.js` (~L408)
`getTotalCredits(q.gym_id) < requiredCount` reading `cache.creditsByGym[gym]`. The page load
also shows the startup gym-less calls (`/api/profile`, `/api/credits`, `/api/eligibility`) answering 400 before the gyms load.

**Root cause:** `api.getCreditsByGym()` answered `[gymId, []]` for a gym whose credit fetch threw (500/429/400/timeout),
and `main.js updateCreditBadge` published that as `cache.creditsByGym`. `[]` means "you hold no credits", which
breaks the "not loaded is not zero" rule; the card then prints "Insufficient Credits". Worse, the card was
painted once from the cached queue and **never repainted** when the credit/eligibility answer arrived, so a wrong
first paint stuck until the next tab switch. **Reproduced locally in real Chrome** (mock, CDP `Fetch` fulfilling
`*/api/credits*` with 500, IndexedDB cleared): card text `Insufficient Credits` at every sample from 0.7s to 5.6s;
unblocked baseline: no warning. Secondary: `getTotalCredits` summed guest-only credits as the member's own.

**Fix:** `client/src/api.js getCreditsByGym` (~L702) omits a failed gym (unknown, answered permissively);
`main.js updateCreditBadge` merges over the last known value instead of replacing, and calls the new
`repaintAutoBookIfVisible()` (also after per-gym eligibility lands); `ui/autobook.js repaintAutoBookFromCache()`
re-renders from the loaded queue; `ui/credit-allowance.js getTotalCredits` skips guest-only credits.
**After (same browser repro):** with `/api/credits` failing the card shows no warning from 0.7s to 5.6s.
**Tests:** `client/src/api-credits-by-gym.test.js`, `credit-allowance.test.js` (U1-13 block).
I could not reproduce the user's exact transient failure on live (it needs a failing credits call with a cold cache
and I made no writes or cache wipes on the user's profile); the mechanism above is the only path that prints this text with a correct server-side balance.

## U1-15 — Timetable still shows a cancelled class as booked

**Root cause (2026-09-29):** two sources of truth for "is this class booked". `timetable.js` kept a module-local
`userBookings`/`userWaitlists`, written only by its own prefetch/`refreshBookingState`; My Bookings wrote
`cache.bookings` and cancelled through the API. Returning to the Timetable tab painted the grid from the timetable's stale local copy,
and it only became true when the tab's prefetch refetch landed (seconds on a live provider). **Reproduced in real Chrome**
(local JAB mock, CDP: book via API, load timetable, My Bookings, real Cancel + Confirm click, back to Timetable, sample the
row's action cell every 0.5s): at 0.0s the row still read `Cancel ⋯`, flipping to `⚡︎ Quick Book` only at 0.5s on a local mock (instant provider).
**After the fix:** `⚡︎ Quick Book` at 0.0s, with the row for the same class.

**Fix:** `timetable.js` (~L231) reads `cache.bookings`/`cache.waitlists` through accessors (its own copies are gone).
`api.js` announces every successful `book`/`cancel`/`swapSpot`/`joinWaitlist`/`leaveWaitlist` as `psycle-bookings-mutated`;
new `ui/booking-state.js` applies the known effect synchronously (a cancel drops the booking; a waitlist leave drops that gym's entry only),
repaints the timetable, then refetches in the background (coalesced) to pick up new rows; installed once from `main.js initApp`.
**Tests:** `client/src/ui/booking-state.test.js`.

## U1-12 — Overlap confirmation before Book and Quick-Book

**Basis (2026-09-29):** `saveAutoBookPreferences` was the only caller of the overlap rule (U1-6); `doQuickBook` and
`openBookingModal(…,'book'|'quickbook')` went straight to booking or to the spot picker with no clash check.

**Fix:** server `competing-bookings.js detectManualBookingOverlaps` (the overlap subset of the ONE rule: queue and
bookings, cross-gym) behind new read-only `POST /api/overlap-check` (`server.js`, next to `competingContextFor`).
Client `api.checkOverlap`; `timetable.js overlapGate()` runs at the top of `doQuickBook` and of `openBookingModal` for `book`/`quickbook`
(so it precedes the spot picker and first-time setup; callers that already asked pass `overlapChecked`);
`overlap-modal.js` takes a `mode` (wording: "New booking", "Book anyway" / "Quick-Book anyway"). Cancel or dismiss resolves false and nothing happens; a failed check lets the booking proceed.
To keep the server's `booking_cache` current for this check, `syncBookingCache` now also runs from the timetable prefetch and after every mutation refetch (`booking-state.js`).
**Tests:** `server/test-competing-bookings.js` (unit + HTTP: queue overlap cross-gym, synced-booking overlap cross-gym, clean time, same-class not a clash, read-only, 400/401),
`client/src/ui/overlap-modal.test.js` (wording per mode).
**Browser (real Chrome, local mock, two gyms):** with a JAB TRAIN booking at 12:00, Quick Book on the overlapping Psycle Ride 45 opened
"Overlapping class … NEW BOOKING Psycle … CLASHES WITH JAB … BOOKED · Cancel · Quick-Book anyway" and the booking modal was NOT shown; Cancel closed it with no booking modal;
a second click then "Quick-Book anyway" opened the spot picker.

## U1-14 — First-time setup intro; occupied spots selectable while setting up

**Root cause (2026-09-29):** in `timetable.js openBookingModal` the spot click handler refused an occupied spot with
"⚠ This bike is occupied or unavailable." for every mode except auto-book (`!isAutoBookMode && !isAvailable`), so
Quick-Book's preference-setting modal (which saves the studio's map, then books) was treated like a real booking of this class.
There was also no intro before the first-ever map. (The user's report matches: refusal text present at the old line ~2829.)

**Fix:** new pure `client/src/ui/spot-selection.js` (`spotSelectionRule`: only mode `book` refuses an occupied spot; auto-book keeps its
"will be targeted" toast; `needsSetupIntro`; exact `setupIntroCopy`). `timetable.js openBookingModal` uses the rule and, when the studio has a
seat map and no saved map (`quickbook`/`autobook` modes), opens on "First-time setup" / "Choose your preferred spots for [Gym] [Location] first." /
"Once set up, **Quick-Book** and **Auto-Book** will always book the best possible spot for you." with a Next button that swaps in the map
(the map is already rendered behind the intro, so Next is instant). After saving, Quick-Book books the best available preferred spot as before.
**Tests:** `client/src/ui/spot-selection.test.js`.
**Browser (real Chrome, local mock; the mock has no occupied spots, so 4 slots were marked unavailable by intercepting `/api/events/1083` in the tab):**
Configure Quick-Book on a studio with no saved map showed title `First-time setup`, "Choose your preferred spots for Psycle Clapham first. Once set up, Quick-Book and Auto-Book will always book the best possible spot for you. Next";
Next showed the map (40 spots); clicking an occupied spot selected it (summary "PREFERRED SPOTS Bike 11", no warning toast).

