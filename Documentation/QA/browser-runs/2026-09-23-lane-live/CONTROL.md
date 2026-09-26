# Browser Automation Run Control — 2026-09-23-lane-live

- **Date**: 2026-09-23
- **Lane**: Lane B (Live Provider Accounts)
- **Environment Label**: `http://localhost:5173` (Vite dev client) / `http://localhost:3000` (Server)
- **Git Commit**: `8387d53dd21b1107c3a3cbba2238b399ba39b76c` (worktree dirty, modular multi-gym uncommitted)
- **Active Browser/Tab Identifier**: `agent-browser --session lane-live`
- **Active User / Account**: `test@piersj.com` (linked to live JAB Boxing Club and Psycle London accounts)
- **Protected Baseline Path**: `Documented in GATE-02` (0 active bookings, 0 active waitlists pre-existing)
- **Approved Live Flow IDs**: `WIN-01`, `WIN-02`, `WIN-04`, `MAP-01`, `MAP-02`, `MAP-03`, `MAP-04`, `AB-01`, `AB-02`, `AB-03`, `AB-04`, `NOTIF-01`, `CAL-01`, `SET-01`, `SET-02`, `SET-04`, `SET-05`, `CLEAN-01`
- **Created IDs Ledger**:
  - `bookings`: []
  - `waitlists`: []
  - `queues`: []
  - `monitors`: []
- **Cleanup Pending**: `None`
- **Changed Settings Ledger**: []
- **Changed Maps Ledger**:
  - `psycle-london:108` (Ride Studio 1): `{"preferredSlots":[28,14,42],"preferredRows":[]}`
  - `psycle-london:154` (Reformer Studio): `{"preferredSlots":[5,12,18,2],"preferredRows":[]}`
  - `jab-boxing:6286` (BOXING): `{"preferredSlots":[36192,36197,36223,36217],"preferredRows":[]}`
  - `jab-boxing:6282` (TRAIN): `{"preferredSlots":[36278,36285,36292],"preferredRows":[]}`
- **Dependency Results**:
  - `GATE-01`: PASS (prior verification on Node 20 / full test suite)
  - `GATE-02`: PASS (baseline verified: 0 active bookings, 0 active waitlists, 0 queues, 0 monitors)
  - `GATE-03`: PASS (lane-live session healthy, clean console, header confirmed)
  - `AUTH-01` through `TT-05`: Completed in Lane A (`2026-09-15-local-mock`)
  - `WIN-01`: PASS (Psycle rolling-weekly window verified: Tuesday M+15 alignment, Mon 12:00 BST release, closed vs open states, JAB independence confirmed)
  - `WIN-02`: PASS (JAB per-class continuous window verified: minute-exact releaseAt matching raw.booking_start_datetime, boundary date Wed 30 Sep open vs Thu 1 Oct closed, NOT LIVE + Auto-Book action, Auto-Book banner shows Nothing queued without Psycle Monday noon coupling, weekly reminder disabled by default)
  - `WIN-04`: FAIL (Psycle open class 'Buy Credits' vs closed class 'Auto-Book'/'NOT LIVE' verified; JAB closed class 'Auto-Book'/'NOT LIVE' verified; JAB open class failed: live account has no active membership on MarianaTek and client timetable.js hardcodes 'Buy Credits' for unmetered gyms when ineligible [QA-16]; header badge unconditionally renders 'JAB Member' despite no active membership [QA-17]; zero credit references on JAB spot picker and Credits tab confirmed)
  - `MAP-01`: FAIL (Coverage verified across Psycle Ride Studio 1, Psycle Reformer Studio, JAB BOXING with Bag/Ground spots, JAB TRAIN Ground spots, and JAB RECOVERY FCFS/no-map; priority badges supplement spot labels; persistence verified in sqlite.db and UI reload. FAILED due to QA-18: Settings Manage maps renders 'Unknown Location' for JAB due to cache.locations cross-gym reuse, and clicking 'Choose Spots' on secondary gym clobbers options.gymId with studio.gymId [undefined], querying Psycle instead of JAB and showing 'No floor map available')
  - `MAP-02`: PASS (One shared preferred map verified across entry points without clearing caches; Ride Studio 1 edited in Settings to [14, 42, 28], Auto-Book modal verified [14, 42, 28], edited to [42, 14, 28] and saved, Settings immediately reflected [42, 14, 28]; restored baseline [28, 14, 42]; cleaned up run-created queues 14, 15)
  - `MAP-03`: PASS (Cross-gym spot map isolation verified across Psycle Ride Studio 1 [108] and JAB BOXING [6286]; Psycle modal displayed only Psycle spots [28, 14, 42]; JAB modal displayed only JAB spots [B1, G5, B14, G11] with 0 bleed; modifying JAB preferences to include B2 [36193] updated JAB DB and UI while Psycle Ride Studio 1 in Settings remained strictly untouched [28, 14, 42]; cleaned up run-created queues 16, 17 and restored JAB baseline [36192, 36197, 36223, 36217])
  - `MAP-04`: PASS (FCFS and unavailable maps verified on JAB RECOVERY [6287]; timetable suppresses 'Configure Auto-Book' on closed rows and suppresses 'Book (choose a spot)' / 'Configure Quick-Book' on open rows; Settings spot editor self-corrects to useful no-map fallback with 🗺️ and 'Save (Any Spot Preference)'; bookings.js code audit records QA-19 for misleading 'Spot ?' chip on active FCFS bookings)
  - `AB-01`: PASS (Future Auto-Book created on closed JAB class [82460, Wed 7 Oct 08:10, releaseAt 2026-09-30T08:10:00+01:00]; timetable row transitioned to Scheduled; card rendered with JAB branding and countdown 6d 5h; persistence verified across full reload)
  - `AB-02`: PASS (Edit Auto-Book and shared studio map verified on queue 18; modified spots in modal, clicked Save Changes; queue preferences and studio_preferences updated in lockstep without card duplication; restored baseline preferences [36192, 36197, 36223, 36217])
  - `AB-03`: PASS (Multi-gym queue ordering and Pause/Resume verified across Psycle [queue 19, releaseAt 2026-09-28T12:00:00+01:00, 4d 9h] and JAB [queue 18, releaseAt 2026-09-30T08:10:00+01:00, 6d 5h]; chronological ordering by release instant confirmed; countdown banner targeted earliest release 4d 9h; pause globally toggled and persisted across reload; resume returned countdown 4d 9h without premature firing)
  - `AB-04`: PASS (Cancel Auto-Book from UI verified; 2-tap confirmation [Confirm?] executed without intermediate mutation; queue 18 deleted; queue 19 deleted; 0 queues remaining in DB; UI reverted to Nothing queued; timetable row 82460 reverted to Auto-Book; all 4 studio preferences in DB confirmed 100% intact)
  - `NOTIF-01`: FAIL (Web push permission states and preference controls verified. Notification Preferences modal inspected: Spot Booked with All/Auto-Book scope dropdown, Spot Upgraded, Credit Warning, Cancellation Reminder with 24h/14h dropdown, and Booking Window Reminder with per-gym sub-toggles. Psycle booking window reminder defaults to ON [true] while JAB defaults to OFF [false]; toggling JAB to ON immediately persisted to account_settings in SQLite and survived full page reload; toggled JAB back to OFF [baseline restored]. Under debugMode, all 9 test notification types triggered successfully. FAILED due to QA-20: server/notifications.js hardcodes 'Psycle:' and 'Psycle' in push notification titles and body copy across all sample builders and live dispatches [notify()], completely ignoring the originating gymId, violating multi-gym brand isolation and WP-D7. Screenshot: screenshots/notif-01-customise-modal.png)
  - `CAL-01`: PASS (Unified account-level calendar feed verified. Exactly one account-level feed URL served; coverage description shows 'Includes classes from JAB Boxing Club and Psycle London in one feed'; live .ics feed verified valid VCALENDAR with Europe/London timezone; calendar.js buildTitle() resolves gym short name for summary prefix ['JAB:' vs 'Psycle:']; feed disabled and baseline restored. Screenshot: screenshots/cal-01-calendar-settings.png)
  - `SET-01`: FAIL (Settings information architecture [IA] and scope verified. Account-level sections [General, Notifications, Account, About] and gym-specific drawers [Your Gyms, JAB Boxing Club, Psycle London] verified properly isolated. Per-gym drawers correctly nest gym-scoped actions while omitting unsupported features. Mobile header back button navigation verified. FAILED due to QA-21: About pane interpolates only one gym name ['JAB Boxing Club'] into disclaimer and introduction via applyGymName[state], omitting Psycle London entirely for multi-gym accounts. Screenshots: screenshots/set-01-general.png, screenshots/set-01-notifications.png, screenshots/set-01-account.png, screenshots/set-01-your-gyms.png, screenshots/set-01-drawer-jab.png, screenshots/set-01-drawer-psycle.png, screenshots/set-01-about.png)
  - `SET-02`: PASS (Credits & Membership capability gating verified across multi-gym persona. Dual summary cards rendered with correct gym branding: JAB displays unmetered model with 'No membership found' and 'Manage at gym ↗' with zero credit references, zero Buy Credits, zero Stripe checkout, zero credit-shortage arithmetic, and no zero balance; Psycle displays metered model with '0 credits available' and 'Buy credits →'. Psycle bundle store browsed with experimental notice, search filter verified [query '10' matched 61 packs], back to all gyms verified. Screenshot: screenshots/set-02-credits-summary.png)
  - `SET-04`: PASS (Profile Explorer verified across JAB Boxing Club [MarianaTek customer id: 60623, Sebastian Clearwater, aiproscw@gmail.com] and Psycle London [CodexFit customer id: 505535, Sebastian Clearwater, aiproscw@gmail.com, stripe_id, cutoff 2026-10-06]; complete cross-gym data isolation with zero bleed; read-only presentation confirmed with zero destructive edit controls. Screenshots: screenshots/set-04-profile-explorer-jab.png, screenshots/set-04-profile-explorer-psycle.png)
  - `SET-05`: FAIL (Debug mode and class diagnostics verified across Psycle London and JAB Boxing Club. Enabling debugMode in Settings > General exposed 'Debug' action in timetable row more-actions menus; opened Debug modal for Psycle row 215948 and JAB row 82102: both displayed correct gym branding, normalized class name, computed keys [isLive, releaseAt, capacity, occupancy], and raw JSON tabs. JAB debug payload verified clean [0 secrets]. FAILED due to QA-22 [P0]: Psycle raw organisation relations payload contains 'shopify_api_password' which openDebugModal renders unredacted in plaintext in the DOM. Disabled debugMode, reloaded page, verified 'Debug' action removed from row menus [baseline restored]. Screenshots: screenshots/set-05-debug-modal-psycle.png, screenshots/set-05-debug-modal-jab.png)
  - `CLEAN-01`: PASS (Mandatory live cleanup and final baseline reconciliation completed. Verified in sqlite.db: auto_bookings: 0, auto_upgrades: 0, booking_cache: 0, waitlist_cache: 0; calendar_token: null, calendar disabled; account settings confirmed clean [autoBookPaused: false, debugMode: false, prefetchWeeks: 4, JAB bookingWindow reminder: false, Psycle: true]; all 4 protected studio preferences matched baseline bit-for-bit [Psycle Ride 108: 28/14/42, Psycle Reformer 154: 5/12/18/2, JAB BOXING 6286: 36192/36197/36223/36217, JAB TRAIN 6282: 36278/36285/36292]; all 5 main tabs verified clean and error-free in browser lane-live. Screenshot: screenshots/clean-01-final-reconciliation.png)
- **Next Permitted Flow**: None (Lane B execution complete)








