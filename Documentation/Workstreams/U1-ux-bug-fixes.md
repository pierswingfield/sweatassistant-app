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
| U1-6 | **Auto-book overlap confirmation modal.** Overlap only produced a fleeting toast (C5-3). *2026-09-28, source: user dev-twin testing.* | Open | 1 d |
| U1-7 | **Settings → Your Gyms renders incrementally and sometimes duplicates.** *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 | 2 h |
| U1-8 | **1:1 gym logo chip on each per-gym Settings submenu item.** *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 | 1 h |
| U1-9 | **"Last authenticated" always says "Not recorded".** README "Verified done" (QA-07) claims it works. *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 (write bug) | 1 h |
| U1-10 | **Icons on Settings menu items** (SVG, not emoji). *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 | 1 h |

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
