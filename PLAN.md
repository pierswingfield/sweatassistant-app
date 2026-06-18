# Psycle PWA — Action Plan

**Goal**: Make the PWA replicate the Chrome extension **exactly** — every flow, logic, and
piece of copy — then overhaul the UI into a responsive web app (full-screen desktop +
iOS-26-style mobile) with system-driven light/dark.

**Source of truth**: [`EXTENSION_SPEC.md`](EXTENSION_SPEC.md) (meticulous feature/flow/logic map
built from `../browser_extension/content.js`). Every parity item below cites a spec section.

**Current stack**: vanilla JS ES modules + Vite + Luxon; Express + SQLite server with
server-side `scheduler.js` / `poller.js` / `push.js`. PWA shell in `client/src/main.js`,
feature modules in `client/src/ui/*`.

**UI approach**: overhaul in place — keep the working vanilla-JS modules, replace the styling
layer with a proper design-token system + responsive shell + iOS-26-style mobile chrome.

---

## Phase 1 — Critical bugs (do first; each is a blocker)

1. **Quick-Book / Auto-Book panes never load.** The ⚙/Auto-Book entry points and/or the
   Auto-Book tab don't render. Port `showAutoBookSelection` (spec §5) and `renderAutoBookingsTab`
   (spec §7). Verify the modal opens from: timetable gear, Auto-Book button, and queue "Edit".
2. **Buy Credits: missing bundle handle** on the bundle card. Add `handle` (and `ID`) to the
   card/detail per spec §2.4.
3. **iOS push says "unsupported."** `'PushManager' in window` is false on iOS Safari unless the
   PWA is installed to the Home Screen (standalone). Detect `navigator.standalone` /
   `display-mode: standalone`; when on iOS-not-installed, show install guidance instead of
   "unsupported" (`main.js:178 updatePushStatusUI`).
4. **App paths / refresh restoration.** Add real routing so refresh returns to the same
   place. Map each tab + open modal/flow to a URL (hash or History API), restore on load
   (`main.js` has no routing today). Routes: `#buy`, `#timetable`, `#bookings`, `#auto-book`,
   `#settings` (+ deep links e.g. `#timetable/class/{id}`).

**Checkpoint**: deploy; verify modals load, bundle handle shows, iOS push messaging correct, refresh restores location.

---

## Phase 2 — Spot Maps editor (broken parity)

5. **Studio spot-map editor** (spec §4). Port the reusable floor-plan editor:
   - Settings → "Manage Maps" → location-grouped, layout-only studio list (spec §4.2).
   - Editor with ordered slot priority badges, whole-row `+/−` selection, cyan row backdrops,
     summary line, Clear/Save (spec §4.3).
   - Persist `studioPreferences[studioId] = { preferredSlots, preferredRows }` (server-side
     per-user store, mirroring `psycleStudioPreferences`).
   - Empty state + copy verbatim (spec §4.2).

**Checkpoint**: can create/edit/remove a studio spot map from Settings and from the Auto-Book config modal.

---

## Phase 3 — Auto-Book / Quick-Book parity

6. **Config modal** (spec §5): mode determination (live→Quick-Book / beyond-cutoff→Auto-Book),
   pre-population priority, slot-map context-B (availability + occupied-selectable + unmapped
   chips + warning), "Slots to book" dropdown, "Book any slot if preferred is unavailable",
   "Save preferred slots" to studio default, correct titles/buttons, "Booking opens" footer.
7. **Booking execution algorithm** (spec §5.6) — replicate `quickBookClass` exactly:
   primary→row→any ordering, per-slot POST, 1500ms spacing, waitlist fallback, requiredCount.
   Confirm the **server** scheduler uses the identical ordering (`server/scheduler.js`).
8. **Auto-Book tab** (spec §7): countdown to Monday 12:00 London + target datetime,
   Pause/Resume, ♥ Auto-Book Favourites (bookmark sync), active vs history cards with
   status badges, per-card countdowns, Edit/Remove, debug simulate button.
9. **Bookmark sync** (spec §6): ♡/♥ persists via CodexFit metafields API; "favourites only"
   filter; "Auto-Book Favourites" syncs bookmarked recurring classes into the queue.

**Checkpoint**: can schedule an auto-book, see the countdown, pause/resume, edit preferences, bookmark a class and sync it.

---

## Phase 3.5 — Timetable & Buy Credits parity polish

10. **Card states & split button** — Quick-Book/Auto-Book/Waitlist/Cancel(+penalty) states,
    gear hidden for seat-map-less classes (spec §3.2–3.4).
11. **Buy Credits** — collapsible "All Available Bundles" (collapsed by default), warning
    banner, 7 default-on filters with exact labels/tooltips, sortable columns, Rtn/Rpt badges
    (spec §2).
12. **Single debug button** — keep 🐛 only; remove any duplicate ℹ button.

---

## Phase 4 — UI overhaul

13. **Design tokens + theming**: CSS custom-property design system; **light/dark via
    `prefers-color-scheme`** (no manual override needed). Define type scale, spacing, radii,
    elevation, color roles once; refactor `styles.css` to consume tokens.
14. **Responsive shell**:
    - **Desktop**: full-screen multi-column layout (sidebar/top nav + content area), not a narrow
      floating panel.
    - **Mobile**: iOS-26-style app chrome — bottom tab bar, large-title headers, momentum
      scrolling, sheet-style modals, safe-area insets, Dynamic-Island-aware spacing.
      Follow Apple HIG + iOS 26 visual conventions: rounded system backgrounds, tinted
      materials, SF-style type hierarchy.
15. **Consistent hierarchy across all tabs**: section headers, body text, button hierarchy
    (primary/secondary/destructive/tinted), list rows, cards, interactive states (hover, press,
    disabled), and spacing — all derived from the token system.
16. **PWA install polish**: manifest `theme-color` per scheme, splash screens, status bar style,
    iOS install hint banner when not in standalone mode (ties into Phase 1 #3).

**Checkpoint**: deploy; test on Safari iOS (installed + browser), Chrome desktop, Safari desktop. Light + dark. All tabs + modals look correct in both layouts.

---

## Phase 5 — Settings parity & debug

17. **Settings sections** mirror the extension exactly (spec §10): Extension Settings
    (Prefetch Range, Manage Maps), Auto-Upgrade (enable + interval), Backup & Restore
    (export/import JSON), Debug (Advanced Booking Privileges, Debug Mode, Explore Profile Data).
    **Do not** add "Advanced Booking Credits (+1 week)" — it isn't in the live extension UI.
18. **Booking-window timing** (spec §11): port `getBookingOffset` / `getBookingCutoffDate` /
    `getClassReleaseTime` semantics client-side; verify server uses identical logic.
19. **Debug surfaces**: per-class 🐛 JSON tree, Profile Explorer, version pill + build timestamp
    in header, optional debug log terminal (bottom-right, minimized by default).

---

## Cross-cutting requirements
- **Copy parity**: reuse exact strings from `EXTENSION_SPEC.md` §14 throughout.
- **Server-side scheduling**: the PWA's advantage is 24/7 auto-book/upgrade without an open tab;
  copy that assumes "keep a tab open" must be reworded, but the *logic* must match the spec.
- **Per-user persistence**: extension `chrome.storage.local` keys map to per-user server
  storage (studio prefs, auto-book queue, paused flag, auto-upgrades).

## Execution order
Phase 1 → 2 → 3 → 3.5 → 4 → 5, deploying and verifying after each phase.
