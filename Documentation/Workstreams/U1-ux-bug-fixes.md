# U1 — UX bug fixes from QA

**Priority:** P1–P2 · **Size:** ~1 day · **Depends on:** nothing · **Nice before:** C4

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Cheap, visible fixes. Run them alongside C3 so they share the same live re-test.

| # | Item | Evidence (verified 2026-09-26) | Est. |
|---|---|---|---|
| U1-1 | **"Spot ?" on FCFS bookings.** My Bookings falls back to `'?'` when a booking has no spot, as at Recovery or JAB FCFS classes. Hide the chip, or show "Open floor". [QA-19, T7] | `client/src/ui/bookings.js` ~L203 | 30 min |
| U1-2 | **About pane lists every linked gym.** It currently names only the context gym (the hardcoded "Psycle" was removed, but multi-gym isn't handled). [QA-10, QA-21] | `client/src/gym-context.js` L71–76 `applyGymName`; `index.html` ~L456 | 1 h |
| U1-3 | **Debug terminal toggles live.** Flipping Debug mode saves the setting, but the terminal only appears or disappears after a reload. Call `updateDebugTerminalVisibility()` on save. [QA-12] | `client/src/ui/settings.js` ~L1760 | 15 min |
| U1-4 | **Recover-screen copy** still says "sign in to a gym you've linked", describing the removed flow. It should say an admin resets passwords. Same lines as C1-4. [QA-05] | `client/src/main.js` ~L1260 | 15 min |
| U1-5 | **Toast dismiss button.** Toasts have an icon and `aria-live`, but auto-hide after 3.5 s with no way to close them or keep errors on screen. Add a close button, and keep error toasts until dismissed. [T5] | `client/src/main.js` L132–168 `showToast` | 1 h |
