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
| U1-7 | **Settings → Your Gyms renders incrementally and sometimes duplicates.** *2026-09-28, source: user dev-twin testing.* | Open | 2 h |
| U1-8 | **1:1 gym logo chip on each per-gym Settings submenu item.** *2026-09-28, source: user dev-twin testing.* | Open | 1 h |
| U1-9 | **"Last authenticated" always says "Not recorded".** README "Verified done" (QA-07) claims it works. *2026-09-28, source: user dev-twin testing.* | ✅ Fixed 2026-09-28 (write bug) | 1 h |
| U1-10 | **Icons on Settings menu items** (SVG, not emoji). *2026-09-28, source: user dev-twin testing.* | Open | 1 h |

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
