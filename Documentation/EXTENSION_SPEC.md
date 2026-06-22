# Psycle Extension — Complete Feature & Flow Specification

> **Purpose**: The single source of truth for what the Chrome extension does, how the
> user reaches each feature, the exact logic behind it, and the copy it uses. The PWA
> must replicate this **exactly** (function, UX, logic, and wording).
>
> **Source**: `../browser_extension/content.js` (~10.2k lines), `interceptor.js`,
> `styles.css`. Line references below point into `content.js`.
>
> **How to use this doc**: Each feature lists **Access** (how the user gets there),
> **Logic** (the rules), and **Copy** (exact strings). The PWA parity checklist in
> `PLAN.md` is derived from this.

---

## 0. Architecture at a glance

- The extension injects one floating **panel** into `psyclelondon.com`. Everything lives
  inside `#psycle-helper-container`.
- It talks directly to the CodexFit API (`https://psycle.codexfit.com/api/v1/customer/...`)
  using the logged-in user's JWT (sniffed from the page / `getBearerToken()`).
- It intercepts the Shopify cart "instance ID" via `interceptor.js` (MAIN world) to enable
  buying hidden bundles.
- **Auto-book/auto-upgrade run client-side**: a 200ms `setInterval` scheduler fires while a
  Psycle tab is open. *(In the PWA this moves server-side — `server/scheduler.js`,
  `poller.js`, `push.js` — but the user-facing logic/UX must match.)*

### Persistent storage keys (`chrome.storage.local`)
| Key | Shape | Purpose |
|-----|-------|---------|
| `psycleSettings` | object | All settings (see §7) |
| `psycleStudioPreferences` | `{ [studioId]: { preferredSlots:[], preferredRows:[] } }` | Per-studio default spot maps |
| `psycleAutoBookings` | `[ booking ]` | Auto-book queue + executed history |
| `psycleAutoBookedBookmarks` | `[ identifier ]` | Bookmarks synced into the queue |
| `psycleAutoBookingsDeleted` | `[ eventId ]` | Tombstones so re-sync doesn't resurrect removed items |
| `psycleAutoBookPaused` | bool | Pause flag for the scheduler |
| `psycleAutoUpgrades` | `[ upgrade ]` | Auto-upgrade monitors |

---

## 1. Global UI shell

### 1.1 Minimized toggle button
- **Access**: Always present, bottom-right. Pulsating **"PJ"** button (`initPulseEffect`, L1259).
- A badge (`#psycle-btn-badge`) shows `✔` when a cart session instance ID is captured while minimized.
- Click → opens the panel.

### 1.2 Panel chrome (L758–783)
- **Header**: round "P" logo, title **"Psycle Assistant"**, version pill `v{manifest.version}`.
- **Status indicators**: `API: Connected` (success badge) and `Sniffing Session...` →
  `Session: Found` (warning→success badge, L3768).
- **Maximize button** (`#psycle-maximize`) toggles `.psycle-helper-maximized` (L1302) — swaps
  maximize/restore icons.
- **Close button** `×` minimizes back to the toggle.
- **Footer** (`#psycle-footer-info`): contextual cart-sniffing hint (see §2.5).
- **Global refresh button** (bottom, `#psycle-global-refresh-btn`): re-fetches data for the
  active tab (L1229 — timetable or bookings).

### 1.3 Auth & passcode overlays (L730–756)
- **Auth overlay** (`#psycle-auth-overlay`): shown when not logged in.
  - Copy: **"Please log into your Psycle account"** / "You must be logged in to view your
    custom bundles and make purchases." / button **"Log In Now"**.
- **Passcode overlay** (`#psycle-password-overlay`): tool is passcode-locked.
  - Copy: **"Tool Locked"** / "Please enter the passcode to access Psycle Assistant." /
    placeholder "Enter passcode..." / button **"Unlock"** / error "Incorrect passcode. Please try again."

### 1.4 Navigation (L785–791) — 5 tabs
`Buy Credits` · `Class Timetable` · `My Bookings` · `Auto-Book` · `Settings`
(default active tab = **Buy Credits**). Switching tabs lazy-renders content (L1206–1259).

### 1.5 Shared modal containers (created once, reused)
- `bookingModal` (`#psycle-booking-modal`, L310) — generic modal used by: booking slot
  selection, auto-book/quick-book config, edit booking, edit studio prefs, auto-upgrade config.
- `spotsModal` (`#psycle-spots-modal`, L337) — "Preferred Spot Maps" manager.
- `debugModal` (`#psycle-debug-modal`, L270) — JSON diagnostics (debug mode).
- `instructorTooltip` / `occupancyTooltip` (L364, L370) — hover tooltips on the timetable.
- `backdropBlur` + `toastContainer` — modal backdrop and bottom-left toast stack (`showToast`, L3878).

---

## 2. Tab: Buy Credits (default)

The bundle discovery + hidden-bundle purchase tool.

### 2.1 Favourite Bundles (L796–801)
- **Access**: Top of the Buy Credits tab, always shown.
- `renderFavorites()` (L3304) renders pinned bundles as cards.
- Favourites are bundles the user pinned (heart) in the table.

### 2.2 All Available Bundles (collapsible, L804–903)
- **Access**: Collapsed by default (`.minimized-table`). Header **"All Available Bundles"**
  with a chevron toggles it open (`#psycle-toggle-table-btn`).
- **Warning banner** (shows on expand, L813): *"**Warning:** Be careful what you choose to buy
  from the below list. Some bundles, such as staff, student, or membership top-up credits could
  look suspicious on your account. Others may be special credits that you won't be able to use
  for your classes. Most of them are hidden by the default filters, but use common sense!"*
  Dismissible (`×`).
- **Search box**: placeholder "Search by name, ID, handle...". Filters live (`renderTable`, L3518).
- **Advanced filters** (toggle "Show Filters", L835): 7 checkboxes, all **checked by default**:
  - `Returning Only` — "Excludes packages with 'Intro Pack' or 'is_first_purchase_only'"
  - `All Studios` — "Excludes studio-specific bundles"
  - `Hide At Home`
  - `Hide Student/Member`
  - `Hide Top-Ups`
  - `Hide Unlimited`
  - `Hide Weird` — "Excludes test, staff, priced 0, and out-of-date items"
- **Table** (L881): sortable columns — `Fav / ID`, `Bundle Name`, `Studios`, `Classes`,
  `Availability`, `Expiry`, `Total Price`, `Cost/Credit`, `Select`.
- Data source: `GET /api/v1/customer/bundles` (`loadBundles`, L1372).

### 2.3 Bundle row badges / identifiers
Per bundle the table/detail computes:
- `isValidAllStudios(b)` → "All Studios" vs "Select Studios Only"
- `isValidAllClasses(b)` → "All Workouts" vs "Excl. Lagree"
- `!b.is_first_purchase_only` → **"Rtn Customers"** vs "1st Purchase Only"
- `!b.is_one_time_purchase_only` → **"Rpt purchase"** vs "One-Time Purchase"

### 2.4 Selected bundle detail (L3671 `showSelectedBundle`)
- **Access**: Click a bundle's "Select" → table folds away, detail card shows.
- Shows: name, `handle (ID: id)`, **Total Cost** `£price/100`, **Cost/Credit**,
  **Credits Count**, **Expiry offset**, the 4 badge pills above, optional description &
  `Terms`.
- **Back to Table** button restores the list (`hideSelectedBundle`, L3726).
- **Purchase Quantity** number input (1–10) + action button.

### 2.5 Cart interception / purchase (the "arm" flow)
- The action button text is state-driven (`updateDetailActionButton`, L3735):
  - Session captured → **"Add to Cart"**.
  - No session, bundle not armed → **"Arm Interception"** (warning style).
  - No session, bundle armed → **"Disarm Override"** (danger style).
- **Logic**: `interceptor.js` (MAIN world) sniffs the Shopify/CodexFit cart "instance ID".
  When armed (`triggerFavPurchase`), the next native "Add to Cart" click on the page is
  intercepted and force-swapped to the chosen bundle ID (`PSYCLE_OVERRIDE_TRIGGERED`, L3866),
  then the page reloads.
- Footer copy when armed: *"**Armed Override Active!** Go click ANY normal 'Add to Cart'
  button on the webpage to replace it with bundle ID {id}."*
- Default footer: *"No session sniffed. Arm a bundle, then click any normal cart button on
  the website to force-replace it."*
- When the panel is left-shifted while the native cart drawer is open (`checkCartDrawer`, L3785).

> **PWA note**: The PWA has a server cart endpoint, so "arm/sniff" UX is replaced by a direct
> add-to-cart, but the bundle list, filters, badges, detail card, and copy must match. The
> **credit bundle handle** is shown on the bundle card in the PWA (`credits.js` → `createBundleCard`
> renders `${b.handle} (ID: ${b.id})`).

---

## 3. Tab: Class Timetable

`renderTimetableGrid()` (L2067). The core booking surface.

### 3.1 Layout
- **Date carousel** — horizontal day-by-day navigation; `selectedTimetableDate` tracks the
  active day. Past-time classes are hidden.
- **Filters** — dynamically populated from the **currently loaded timetable data** (not all
  possible relations): Location, Studio, Instructor, Workout Type, plus AM/PM and a
  "favourites only" toggle (`showBookmarksOnly`).
- **Event cards** grouped by day.

### 3.2 Event card states (mirrors native website, see website_function_documentation.md §3.2)
| State | Condition | UI |
|-------|-----------|----|
| Bookable | within booking window & not full | Quick-Book / Book button |
| Beyond cutoff | not yet released (`getClassReleaseTime` in future) | greyed + **Auto-Book** button |
| Full + waitlistable | `is_fully_booked && is_waitlistable` | **Join Waitlist** |
| Full no waitlist | `is_fully_booked && !is_waitlistable` | disabled |
| Booked (single slot) | user has 1 booking | **Cancel** (double-click confirm; "(Penalty)" if <12h) |
| Booked (multi slot) | user has >1 booking | link to **My Bookings** |
| No usable credit | `hasUsableCredit(event)` false (L1730) | eligibility alert |

### 3.3 Per-card controls
- **Favourite heart** (♡/♥): `toggleNativeBookmark` (L1614) → CodexFit metafields API
  (see §6). Optimistic toggle.
- **Split book button** (L6840): a main action button + a **⚙ gear** context button. The gear
  opens the **Auto-Book / Quick-Book config modal** (§5). Classes **without a seat map** show
  only the main button (no gear).
- **Debug 🐛 button** (debug mode only) → `showClassDebug` (L2970).

### 3.4 Booking actions
- **Quick Book** (seat-map-less): books the first available slot immediately, no modal.
- **Quick Book / Book (seat map)**: opens slot-selection modal (`showBookingSlotSelection`, L5744 →
  `openBookingModalForEvent`, L5001).
- **Auto-Book** (beyond cutoff): opens the config modal in Auto-Book mode (§5), saving a queue entry.
- **Join Waitlist**: `PUT /waitlists/{eventId}`.
- **Cancel**: double-click confirm; penalty warning if <12h (`apiCancelBooking`, L173).

---

## 4. Spot Map Editor (Preferred Spots)

A reusable floor-plan editor. Appears in **two contexts** with shared rendering logic.
In the PWA, this is implemented as `client/src/ui/spotmap.js` (`renderStudioFloorPlan`),
reused by Settings → Manage Maps, the Auto-Book/Quick-Book config modal, and the
Auto-Upgrade config modal. The PWA uses **one shared map per studio** (not per-entry
preferences like the extension).

### 4.1 Data model
`psycleStudioPreferences[studioId] = { preferredSlots: number[], preferredRows: number[] }`
- `preferredSlots` — **ordered** list of slot IDs (order = priority; badge shows 1,2,3…).
- `preferredRows` — list of row Y-coordinates (rounded to 0.1) representing whole-row preferences.

### 4.2 Context A — Settings → "Manage Maps" (`showManageSpotsModal`, L7170)
- **Access**: Settings tab → **Preferred Spot Maps** row → **"Manage Maps"** button.
- `renderSpotsModalContent` (L7016): lists studios **grouped by location**, accordion-collapsed.
  - Only studios that (a) appear in the currently-loaded timetable (`psycleEvents`) **and**
    (b) have a layout with slots are shown.
  - Empty state: 🗺️ **"No Studios Loaded"** / "Please refresh the timetable first to load the
    active locations and studios."
  - Each studio row: name + button **"Choose Spots"** (no prefs) or **"Edit Spots"** (has prefs,
    purple), plus a **"Remove"** button when prefs exist (double-click → **"Confirm?"** → deletes,
    toast "Studio defaults removed!").
- Clicking Choose/Edit → opens `showEditStudioPrefsModal(studioId)` (L7187).

### 4.3 The editor itself (`showEditStudioPrefsModal`, L7187)
- Title: **"Preferred Spots: {studioName}"** (strips leading "Psycle ").
- **Floor plan** rendered from `studio.layout.slots` + `objects`:
  - Slots positioned by normalized `x/y` → `% left/top` (formula: `((x-minX)/widthRange)*78+8`,
    `((y-minY)/heightRange)*72+14`). Stage label(s) from `layout.objects`.
  - **Selected slots** get class `autobook-selected` + a purple priority badge (index+1).
  - **Whole-row selection**: a `+` / `−` button at the right edge of each row (`x≈95.5%`);
    selected rows draw a cyan rounded "backdrop" behind the row.
  - Click a slot → toggles it in/out of `preferredSlots` (append = lowest priority). Re-renders.
  - Click a row `+` → toggles the row's Y in `preferredRows`.
- **Summary line**: `Selected Preferences: Spots [A, B, C...] > Rows [1, 2...]` (priority order,
  `>` separators). Empty: "(None selected yet)".
- Helper copy: *"Click on the spots to set your priority order. Click the **+** button on the
  right to prefer entire rows."*
- **Buttons**: **"Back to List"** (returns to Manage modal), **"Clear Defaults"** (clears both
  arrays in-memory), **"Save Defaults"** (persists; if both empty deletes the key; toast
  **"Studio defaults saved successfully!"**).
- `returnContext` support: when opened from auto-upgrade config, "Back to List" is hidden and
  save returns to the upgrade modal (`openAutoUpgradeModal`).

### 4.4 Context B — inside Auto-Book / Quick-Book config (§5)
Same floor plan + row logic, but additionally:
- Shows **availability**: available slots clickable; **occupied** slots greyed but still
  selectable (so you can pre-pick a spot before release). Occupied-but-selected → red ring.
- **"Additional Available Spots"** section for available slots not present in the layout
  (unmapped) — rendered as chips.
- **"Save preferred slots" / "Clear preferred slots"** buttons write this class's selection
  back to the studio default (`psycleStudioPreferences`).
- Warning if you selected occupied slots: *"Warning: you have selected N slot(s) that are not
  available for this class."*

---

## 5. Auto-Book / Quick-Book config modal

`showAutoBookSelection(eventId, forceAutoBookTitle, forceAutoBookSave)` (L7479). **One modal**
serves both flows; mode is decided by whether the booking window is open.
In the PWA, this is implemented as `timetable.js` → `openBookingModal(event, mode)` with
three modes: `'book'` (simple seat selector), `'quickbook'` (preference setter + book),
`'autobook'` (preference setter + schedule). All three render the shared floor-plan editor
from `spotmap.js`.

### 5.1 Access
- Timetable card **⚙ gear** button (seat-map classes), or **Auto-Book** button (beyond cutoff),
  or **Edit** on an existing queue entry.

### 5.2 Mode determination (L7534)
```
classRelease = getClassReleaseTime(event.start_at)
isLive = forceAutoBookSave ? false
       : (event.is_always_bookable ? true : now >= classRelease)
showAutoBookTitle = forceAutoBookTitle || !isLive
```
- **Live** (window open) → title **"Quick-Book: {date} {time} {type} with {instr}"**, primary
  button **"Quick-Book Now"** → books immediately via `quickBookClass`.
- **Not live** (beyond cutoff) → title **"Auto-Book: …"**, primary button **"Save Auto-Book"** →
  writes a queue entry.

### 5.3 Pre-population priority (L7558)
1. Existing queue entry for this event → its saved preferences.
2. Else studio default (`psycleStudioPreferences[studioId]`).
3. Else empty (`requiredCount=1`, `bookAny=true`).

### 5.4 Controls
- The full spot-map editor (§4.4).
- **"Slots to book:"** dropdown — `1..max_bookable_slots` (default 4).
- **"Book any slot if preferred is unavailable"** checkbox (default checked = `bookAny`).
- Footer: **"Booking opens: {date} {time}"** (or **"Booking window is open"** when live).
- Save button disabled if a seat-map class has zero available selected slots.

### 5.5 Save (not live) — queue entry shape (L8054)
```js
{ eventId, studioId, startAt, classDate, className, instructorName,
  locationName, studioName, addedAt,
  preferences: { preferredSlots, preferredRows, requiredCount, bookAny } }
```
Toast **"Scheduled for Auto-Booking!"**; re-renders timetable + Auto-Book tab; clears any
tombstone in `psycleAutoBookingsDeleted`.

### 5.6 Booking execution algorithm (`quickBookClass`, L6856) — replicate exactly
Used by Quick-Book-now AND the scheduler at release:
1. `GET /events/{id}` → `liveAvailable` = available slot IDs.
2. If none available → fall back to **join waitlist** (`PUT /waitlists/{id}`), toast warning.
3. Build ordered `slotsToTry`:
   - `primarySlots` = `preferredSlots ∩ liveAvailable` (in saved priority order).
   - `rowSlots` = available slots in `preferredRows` not already in primary.
   - If `bookAny` (or no seat map): append all remaining available slots.
4. Loop until `bookedCount === requiredCount` or slots exhausted:
   - `POST /bookings { event_id, slots:[slot] }` one slot at a time.
   - On success: toast "Quick-booked slot {n} for {class}!".
   - **1500ms delay between attempts.**
5. After ≥1 booking: refresh profile, re-render timetable + My Bookings; if class has a seat
   map, tip toast suggesting Auto-Upgrade.

---

## 6. Bookmarks (Favourites)

- **Identifier** (`generateBookmarkIdentifier`, L1582): `studio.id + "0000" + moment(start_at).format("d0000HHmm")`
  → stable per studio + weekday + time (resilient to instructor/name changes).
- **Toggle** (`toggleNativeBookmark`, L1614): `PUT`/`DELETE`
  `/profile/metafields/bookmarks.events.{identifier}` with body `{ data: identifier }`.
- Stored in `userProfile.metafields.public.bookmarks.events`.
- **"Show favourites only"** filter on the timetable uses these.
- **Auto-Book Favourites** (§7.4 / Auto-Book tab): syncs all bookmarked recurring classes in
  the loaded timetable into the auto-book queue (`syncBookmarkedAutoBookings`, L1813;
  `showAutoBookBookmarksModal`, L8104).
  > ⚠️ **PWA gap**: The PWA's Auto-Book Favourites modal (`autobook.js` → `openFavouritesModal`)
  > saves `autoBookFavourites` (a list of bookmark identifiers) to user settings, but nothing in
  > `server/scheduler.js` consumes this list to auto-create queue entries each week. The
  > extension's `syncBookmarkedAutoBookings` logic has not been ported.

---

## 7. Tab: Auto-Book

`renderAutoBookingsTab()` (L6432).

### 7.1 Countdown header (L6565)
- **"Next Booking Window:"** + live countdown to next Monday 12:00 PM London
  (`getNextReleaseTime`), formatted `Nd HHh MMm SSs`; turns red ≤30s, **"RELEASE ACTIVE!"** at 0.
- Sub-label: **"Monday 12:00 PM London Time"** / `Target: {localized datetime}`.
- When paused: shows **"PAUSED"** / "Auto-Book Paused".

### 7.2 Header buttons
- **Pause / Resume Auto-Book** (`psycleAutoBookPaused` toggle) — red when running, green "Resume" when paused.
- **♥ Auto-Book Favourites** — opens the bookmarks-sync modal.
- **⚡ Simulate Booking Release Window (opens in 60s)** — debug mode only.

### 7.3 Scheduled list (L6602)
- Intro copy: *"Classes added here are automatically booked or waitlisted the moment they open.
  You must keep a Psycle page open with this assistant active before 12:00 PM on Mondays for
  auto-booking to trigger."* *(PWA: server-side, so this caveat changes.)*
- Empty state: "No scheduled classes in backlog. Go to the **Class Timetable** tab to schedule
  classes beyond the cutoff."
- **Active card** (per entry): bold date pill + time + CLASS NAME + "with {instructor}" +
  "{location} ({studio})". Second line: **"Preferred: {N spots, M rows}"** · **"Required slots:
  {n}"** · **"Fall back to any available slot: {Yes/No}"**. Right side: per-card countdown
  (to that class's release), **Edit**, **Remove**.
- **History card** (executed, this session only): status badge `success` (green) / `waitlist`
  (amber) / `upgrade` (purple) / `failed` (red) + execution message + **Clear**. Successful
  executions collapse out of view on next tab visit (after `autoBookTabVisitedAt`); failed ones
  persist.

### 7.4 Scheduler logic (`initAutoBookScheduler`, L9019) — 200ms tick
- Updates all countdowns each tick.
- `activeAutoBookings` = queue entries whose `getClassReleaseTime ≤ now + 60s`.
- **T-30s**: `prefetchAutoBookSlots` warms the `/events/{id}` slot data.
- **T-0s**: `executeAutoBookQueue` runs `quickBookClass` (§5.6) for each, marks `executedAt` +
  `executionStatus` + `executionMessage`.
- Skipped entirely while `psycleAutoBookPaused`.

---

## 8. Tab: My Bookings

`renderMyBookings()` (L6082). Two tables: **Active Bookings** and **Active Waitlists**.
- Source: `GET /bookings?limit=100&page=1` and `GET /waitlists?page=1` (`fetchUserProfile`, L1671).
- **Grouping**: multiple slots in the same class are grouped under one row with a single
  **Cancel** that removes all slots. Slot labels resolved from the studio layout
  (`getSlotLabelFromBooking`, L1432).
- **Cancel booking**: red warning banner; **"(Penalty)"** label if <12h before class
  (credit lost). Double-click confirm.
- **Leave waitlist**: always penalty-free.
- **Add to calendar**: `.ics` download (`downloadICS`, L1511).
- **Auto-Upgrade setup**: per booking with a seat map, an entry point to configure auto-upgrade
  (`openAutoUpgradeModal`, L9662); `autoUpgradeCache` drives "Upgrading…" labels.
- In the PWA, bookings rendering is defensive against missing event/relation data
  (guards with `if (!event || !event.start_at) return;`). Auto-upgrade setup uses the
  shared floor-plan editor via `bookings.js` → `openUpgradeConfigModal`.

---

## 9. Auto-Upgrade

- **Setup**: from My Bookings, `openAutoUpgradeModal` (L9662) — reuses the spot-map editor to
  pick *better* preferred slots; `returnContext` lets the spot editor return here.
- **Engine**: `initAutoUpgradeScheduler` (L9391) polls `/events/{id}` at the configured interval
  (1 min / 15 min / 1 hr). When a higher-priority preferred slot opens, it books the new slot
  and cancels the old one, then records the upgrade (`psycleAutoUpgrades`) and surfaces a
  history badge in Auto-Book history (`upgrade`).
- `removeAutoUpgradeForBooking` (L185) clears a monitor when its booking is cancelled.

---

## 10. Tab: Settings

`#tab-settings` (L940–1130). Sections, in order:

### 10.1 Extension Settings
- **Timetable Prefetch Range** — number (1–12, default **4**) weeks to pre-fetch.
  "Number of weeks of classes to fetch automatically (Default: 4)."
- **Preferred Spot Maps** — **"Manage Maps"** button → §4.2.
  "View, preview, or remove your saved slot/row defaults for each studio."

### 10.2 Website Enhancements *(extension-only; N/A or reinterpreted for PWA)*
- **Quick-Book on Native Timetable** (toggle) — injects buttons into the real site.
- **Open Bookings in New Tab** (toggle).
- **Smart Timetable Caching** (toggle) — "Cache timetable data for 4 hours. Always refreshes
  before 12PM Monday (booking window release)."

### 10.3 Auto-Upgrade
- **Enable Auto-Upgrade** (toggle).
- **Check Interval** select — "Every minute" / "Every 15 min" / "Every hour".

### 10.4 Backup & Restore
- **Export/Import Preferences** — JSON of all config/defaults/templates. Filename
  `psycle-extension-preferences.json` (L4081). Toasts: "Preferences exported successfully!",
  "Preferences imported successfully! Reloading UI...".

### 10.5 Debug Settings
- **Advanced Booking Privileges** (toggle) — "Auto-detected from your membership. Toggle on if
  auto-detection fails." (drives `getBookingOffset` +7 days).
- **Debug Mode** (toggle) — exposes 🐛 diagnostics buttons, raw JSON, and the release-window
  simulator.
- **Explore Profile Data** — **"Explore Data"** button → `showProfileExplorerModal` (L8672).
- **Save Settings** button (bottom right).

> Note: the extension README mentions "Special Advanced Booking Credits (+1 week)"
> (`advancedBookingCredit`, +7 in `getBookingOffset`) but it is **not** surfaced as a settings
> row in current `content.js`. The PWA should NOT add an "Advanced Booking Credits (+1 week)"
> row (it doesn't exist in the live extension UI).

---

## 11. Booking-window timing logic (replicate exactly)

`getBookingOffset()` (L1742): base **8** days; **+7** if `advancedBooking`; **+7** if
`advancedBookingCredit`.

`getBookingCutoffDate()` (L1751):
1. If profile present: use `extended_cutoff` when `metafields.extended_booking_allowed` or
   `advancedBooking`, else `booking_cutoff`; set time to 23:59:59.999.
2. Else fallback: most-recent Monday 12:00 (rolling back if `now` < that Monday) + offset days,
   23:59:59.999.

`getClassReleaseTime(classDate)` (L1786): finds the Monday 12:00 PM whose window
(`Monday + offset` at 23:59:59) first covers the class date — i.e. the exact moment that class
becomes bookable. Used for countdowns and scheduler triggers.

---

## 12. Debug & diagnostics (debug mode)

- **🐛 per-class debug** (`showClassDebug`, L2970): full event JSON tree (`renderJsonTree`, L2924)
  + booking/waitlist context.
- **Profile Explorer** (`showProfileExplorerModal`, L8672): browse raw CodexFit profile fields.
- **Profile Editor** (`showProfileEditorModal`, L8307): edit/inspect profile metafields.
- **Simulate release** button (Auto-Book tab): forces a release window in 60s for testing.
- **Version pill** in header; debug log behaviour referenced in PLAN.

---

## 13. CodexFit API surface used (see `../api_documentation.md` for full detail)

Public: `events`, `events/{id}`, `instructors`, `event-type-groups`, `event-types`,
`locations`, `studios`, `bundles`.
Auth: `profile`, `credits?type=unused`, `bookings`, `waitlists`, `subscriptions`.
Actions: `POST bookings {event_id, slots[]}`, `DELETE bookings/{id}`,
`PUT/DELETE waitlists/{id}`, `PUT/DELETE profile/metafields/bookmarks.events.{identifier}`.

---

## 14. Copy index (exact strings to reuse)

Collected above inline. The PWA must reuse wording verbatim for: auth/passcode overlays, the
bundle warning banner, all 7 filter labels + tooltips, badge pills (Rtn Customers / Rpt
purchase / etc.), spot-editor helper + summary text, auto-book/quick-book titles & buttons,
"Book any slot if preferred is unavailable", "Booking opens: …", "Scheduled for Auto-Booking!",
the Auto-Book tab intro + empty state, countdown labels, and all toasts referenced in §2–§9.
