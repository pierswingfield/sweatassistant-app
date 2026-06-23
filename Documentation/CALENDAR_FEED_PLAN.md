# Calendar Feed — Scope & Plan

**Branch:** `feat/calendar-feed`
**Status:** Proposal / not yet implemented
**Author:** scoping pass, 2026-06-23

Publish a user-specific, always-current iCalendar (`.ics`) feed of a user's Psycle
classes — confirmed bookings plus (optionally) tentative ones (waitlisted +
Auto-Book scheduled). Users **subscribe once** in Apple Calendar / Google
Calendar; their device then keeps itself in sync automatically.

---

## 0. The one hard constraint to understand first

**A PWA cannot write to the native iOS/Android calendar, even with permission.**
There is no Web API for it. Every fitness app that "adds classes to your calendar"
(Peloton, ClassPass, Apple Fitness+) does it the same way: a **subscribed `.ics`
feed**. We expose an authenticated URL; the calendar app polls it and reconciles.

Consequences that shape this whole design:

- **We push nothing.** The phone *pulls* the feed on its own schedule.
- **We do not control refresh cadence.** Apple Calendar refreshes subscribed
  calendars roughly every few hours (user-selectable: 5 min / 15 min / hourly /
  daily / "push"); Google polls a feed on its own opaque schedule (often
  several hours, sometimes up to ~24h). **We cannot force the device to refresh.**
  What we *can* guarantee is that **our feed is never more than ~3 hours stale from
  background polling, and is fresh within seconds of any in-app action** — so
  whenever the device does poll, it gets current data. We set
  `X-PUBLISHED-TTL:PT3H` / `REFRESH-INTERVAL:PT3H` as a *hint* to clients.
- **Removal is automatic and free.** In a subscription feed, an event that
  disappears from the feed is removed from the device on the next poll. We do not
  need `METHOD:CANCEL` — we simply stop emitting cancelled/unbooked classes.
- **"Add/remove from calendar" reduces to "what VEVENTs does the feed contain
  right now."** The whole feature is: keep a correct, current set of VEVENTs per
  user, served at a stable URL.

This is worth stating plainly in the UI so expectations are right (see §6 copy).

---

## 1. What goes in the feed

One **VEVENT per class**, never per spot/booking. A class the user booked into
two bikes is still a single event with both bike numbers listed.

| Category | Source of truth | Included by default? | VEVENT treatment |
|---|---|---|---|
| **Confirmed booking** | `booking_cache` rows (grouped by `event_id`) | ✅ always | Solid event, `STATUS:CONFIRMED` |
| **Waitlisted** | CodexFit waitlists endpoint (see §3 gap) | ⚙️ optional toggle | `STATUS:TENTATIVE`, title prefix |
| **Auto-Book scheduled** | `auto_bookings` where `status='pending'` | ⚙️ optional toggle | `STATUS:TENTATIVE`, title prefix |

"Optional" = governed by the single **"Include classes I haven't booked yet"**
setting (§5/§6). Confirmed bookings are never optional.

### De-duplication & precedence

A class can appear in more than one source (e.g. an Auto-Book entry that already
succeeded also now exists as a confirmed booking). Resolve by `event_id` with this
precedence — **highest wins, only one VEVENT emitted:**

```
confirmed booking  >  waitlisted  >  auto-book pending
```

So once Auto-Book succeeds and the booking shows up in `booking_cache`, the same
class silently flips from a tentative event to a confirmed one **at the same UID**
(see §4) — the device updates the existing entry in place rather than creating a
duplicate. This directly satisfies "when auto-book/auto-upgrade is successful, the
entry should be updated too."

---

## 2. The publish job — hourly background + immediate on in-app actions

**One shared cron for all users** (`cron.schedule('0 * * * *', …)`), not a
per-user job. Decision (locked): background regeneration is **hourly**; any in-app
action that changes a user's classes regenerates *that user's* snapshot
**immediately**.

The hourly job is also the **single CodexFit poll** for calendar-enabled users —
it fetches both bookings **and** waitlists (§3.2) in one pass and refreshes the
caches the rest of the app reads. We fold the existing 6-hourly
`refreshBookingCaches()` into this so CodexFit isn't double-polled. Most other
inputs are already local DB:

- **Confirmed bookings** → `booking_cache` (refreshed by this 3-hourly poll + in-app
  sync/proxy hook).
- **Waitlists** → new `waitlist_cache` (refreshed by this 3-hourly poll; §3.2).
- **Auto-Book pending** → `auto_bookings` (local).
- **Auto-Upgrade** changes → `auto_upgrades` (local); on success the new booking
  also flows into `booking_cache`.

Each run:

1. For each calendar-enabled user: fetch bookings + waitlists from CodexFit
   (staggered with jitter, as `refreshBookingCaches` already does), update caches.
2. Read confirmed + tentative rows; resolve location addresses + slot labels
   (cached; §3).
3. Serialize to an `.ics` string.
4. Store in a new `calendar_snapshots` table keyed by user, with `etag` +
   `generated_at`. **This is the "publish" step** — the feed endpoint serves this
   pre-built string, so a calendar client polling at an arbitrary moment never
   blocks on generation.

> **Why pre-build instead of generate-on-request?** Calendar clients send
> conditional requests (`If-None-Match` / `If-Modified-Since`). Serving a cached
> snapshot lets us answer `304 Not Modified` cheaply and keeps the hot path off
> the CodexFit API entirely. The hourly job + immediate-on-action hooks are the
> only writers.

**Immediate regeneration hooks** (fresh within seconds, no waiting for the hour):
Auto-Book success, Auto-Upgrade success, in-app book/cancel via the proxy hook,
manual waitlist join/leave, and `POST /api/bookings/sync`. Each calls a cheap
`regenerateSnapshot(userId)` (DB-only; no CodexFit call needed because the action
already updated the relevant cache). Out-of-app changes made on the Psycle website
reconcile on the next hourly poll (≤1h).

---

## 3. Data gaps to close

These exist today and the feature needs them:

1. **Location address.** `booking_cache` stores `location_name` but not a street
   address. Address comes from `GET /locations` (`id`, `name`, `address`).
   **Decision (locked):** fetch `/locations` once and cache server-side in
   `server_kv` as `locations_json` with a **very long TTL** (locations effectively
   never change — refresh weekly / on cache-miss), mapping
   `location_id`/`location_name` → `address`. Used for the VEVENT `LOCATION` field.
   Fallback to `location_name` alone if the lookup misses.
2. **Waitlist data is not cached server-side — we will add it.** Today only the
   Auto-Book *fallback* waitlist join is recorded (`auto_bookings.status='waitlist'`);
   manual waitlist joins live only in CodexFit (`GET /waitlists`).
   **Decision (locked): invest in waitlist caching now.** Add a new
   `waitlist_cache` table (mirrors `booking_cache`: one row per waitlisted class
   with event/start/class/instructor/studio/location). The hourly calendar poll
   (§2) fetches `/waitlists` alongside `/bookings` and replaces the cache. In-app
   waitlist join/leave updates the cache immediately + triggers snapshot regen.
   This covers both manual and Auto-Book-fallback waitlists from one source of
   truth.
3. **Slot/bike labels for tentative classes.** Confirmed bookings already carry
   `slot_label` in `booking_cache`. Auto-Book pending entries store *preferred*
   slots (not a guaranteed seat), so tentative events should show the *target*
   spots with language that signals they're not confirmed (e.g. "Target bikes
   3, 4"). Resolve labels via the shared studio map / studio layout already used
   by the poller.

---

## 4. VEVENT identity, updates, and removal

The mechanics that make "auto-update" and "auto-remove" work:

- **`UID` is stable per class, per user, for the life of that class.** Use
  `UID:psycle-{userId}-{eventId}@psycle.wingfield.tech`. Because the UID keys off
  `event_id` (not booking_id or status), a class keeps the same UID as it moves
  tentative → confirmed, or as its slot changes via Auto-Upgrade. The calendar
  client treats same-UID as "update this event," not "add a new one."
- **`SEQUENCE` increments on every change** to a given UID (slot upgraded, status
  promoted, instructor swapped). Calendar clients use `SEQUENCE` to know the event
  is newer and re-render it. Store a per-(user,event) sequence counter in the
  snapshot table and bump on any field change.
- **`LAST-MODIFIED` / `DTSTAMP`** set to the generation time.
- **Removal:** a cancelled/unbooked/past class is simply **omitted** from the next
  snapshot. On the next device poll it vanishes. (Past classes: keep emitting for
  a short trailing window — e.g. 24h — so history isn't yanked instantly, then drop.)
- **No `METHOD:CANCEL` needed** — that's for `.ics` *invites* sent by email, not
  subscription feeds.

---

## 5. Title & description layout (prescribed)

Goal: everything the brief asked for — event name, instructor, location address,
studio, spot/bike number(s) — visible, with the most scannable bits in the title
and the rest in a clean description. Keep titles short enough not to truncate in a
month view.

### Title (prescribed — locked)

```
Psycle: {Discipline} with {Instructor}, {LocationName}
```

Tentative classes get a `[Tentative] ` prefix.

- `{Discipline}` = the human-friendly group/discipline (`Ride`, `Barre`,
  `Reformer`) — Title Case, not the SHOUTY group code.
- `{Instructor}` = instructor first name (or full name if no first name).
- `{LocationName}` = short location name (`Oxford Circus`, `Victoria`) — **not**
  the full address (that goes in `LOCATION:`).

**Examples**

| State | Title |
|---|---|
| Confirmed ride | `Psycle: Ride with Johan, Oxford Circus` |
| Confirmed barre | `Psycle: Barre with Geoff, Victoria` |
| Auto-Book pending | `[Tentative] Psycle: Ride with Johan, Oxford Circus` |
| Waitlisted | `[Tentative] Psycle: Barre with Geoff, Victoria` |

### Location field (`LOCATION:`)

Full address so the calendar's "directions" tap works:

```
Psycle Oxford Circus, 76 Margaret St, London W1W 8SX
```

(`{studioLocationName}, {address}` — studio room name lives in the description,
not here, to keep map lookups clean.)

### Description (`DESCRIPTION:`) — prescribed (locked)

Status first (most scannable), then the spot line, then class details. Stable
order. The `*…*` emphasis matches the requested style — **note** most calendar
clients render plain text, so asterisks may show literally; that's acceptable and
consistent across clients.

```
Status: Booked ✓
You're on spot 5! (Auto-Upgrade is enabled)
*Class:* RIDE: Signature 45
*Instructor*: Sinead
*Studio*: Ride Studio 1, Oxford Circus
Starts:     Mon 30 Jun, 18:30 (45 min)
```

**Line-by-line rules & variants by state:**

- **`Status:`**
  - Confirmed → `Booked ✓`
  - Auto-Book pending → `Auto-Book queued — books at release` (+ a `Release: Mon
    23 Jun, 12:00` line)
  - Waitlist → `On waitlist`
- **Spot line** (only when a seat is held, i.e. confirmed):
  - `You're on spot 5!` — append ` (Auto-Upgrade is enabled)` *only* if an active
    auto-upgrade monitor exists for this class.
  - Multi-spot → `You're on spots 3, 4!`
  - Tentative (no seat held) → omit this line, or for Auto-Book pending show
    `Target spots: 3, 4` (preferred, not guaranteed).
- **`*Class:*`** → `{GROUP}: {Class Name}` (e.g. `RIDE: Signature 45`).
- **`*Instructor*:`** → instructor full name.
- **`*Studio*:`** → `{Studio room}, {LocationName}` (e.g. `Ride Studio 1, Oxford
  Circus`).
- **`Starts:`** → `{Day Date, HH:mm} ({duration} min)`, `Europe/London`.
- **After Auto-Upgrade success** the spot line reflects the new seat and
  `SEQUENCE` bumps so the device updates in place.

A trailing managed-by note is appended on its own line:
`— Managed automatically by Psycle Assistant. Edits here won't sync back.`

### Other VEVENT fields

- `DTSTART` / `DTEND` — `Europe/London`, via `VTIMEZONE` block (DST-correct; never
  bare UTC offsets baked in). Duration from event `duration`.
- `STATUS` — `CONFIRMED` (booked) vs `TENTATIVE` (auto-book/waitlist).
- `URL` — deep link back into the app for that class if we have one, else app root.
- `CATEGORIES` — `Psycle`, plus the group, for users who colour-code.
- No `VALARM` by default (we own reminders via push; a calendar alarm would
  double up). Could be a future per-user toggle.

---

## 6. Settings section

New Settings card: **"Calendar"** (sits near Notifications). Contents:

1. **Subscribe / Unsubscribe controls** (deep links, §7):
   - "Add to Apple Calendar" → `webcal://` link.
   - "Add to Google Calendar" → Google "add by URL" link.
   - "Copy feed URL" → for any other calendar app (Outlook, Fastmail…).
   - Once subscribed there's no reliable way to detect it from the web, so
     "unsubscribe" is **instructional** ("Remove the *Psycle Assistant* calendar
     from your Calendar app's settings") **plus** a real kill-switch:
   - **"Turn off calendar feed"** — disables generation and **rotates/revokes the
     feed token** so the URL 404s/410s. This is the true off switch; the device's
     stale subscription then simply stops updating.
2. **"Include unconfirmed classes"** toggle — controls tentative events.
   **Copy (locked):**
   > **Include unconfirmed classes** — show classes pending Auto-Book or a
   > waitlist.

   Default **off** (confirmed-only is the least surprising default; tentative
   events that never materialise are the main support-noise risk).
3. **Status line:** "Feed last updated 12 min ago · 4 classes" for reassurance.
4. **Regenerate / rotate link** (advanced): rotate the token if the URL leaks.

---

## 7. Subscribe deep links

The feed lives at a tokenised, auth-by-URL endpoint (calendar apps can't send
Bearer headers):

```
GET /api/calendar/:token.ics       → 200 text/calendar  (or 304 / 410)
```

`:token` is a per-user, **rotatable, high-entropy** secret (NOT the JWT — JWTs
expire in 30 days and calendar subs are long-lived). Store as
`users.calendar_token` (new nullable column) generated on first enable.

Subscribe links:

- **Apple / generic:** `webcal://psycle.wingfield.tech/api/calendar/{token}.ics`
  — tapping `webcal://` on iOS/macOS opens Calendar's subscribe sheet directly.
- **Google:** `https://calendar.google.com/calendar/r?cid={URL-encoded https URL}`
  — opens Google Calendar's "add calendar from URL" flow. (Google requires the
  `https://` form, URL-encoded, as `cid`.)
- **Copy URL:** the raw `https://…/{token}.ics` for Outlook/Fastmail/Thunderbird.

Security notes:
- Token in URL = bearer capability. Mitigate: long random token, rotation on
  demand, revoke on "turn off", and on `DELETE /api/auth/me` (account wipe).
- Rate-limit the endpoint (it's unauthenticated-by-header).
- Return `410 Gone` for revoked tokens so clients stop polling.
- No PII beyond class schedule; still treat the URL as a secret in copy.

### ⚠️ Cloudflare Access — the feed path MUST be exempted

**Production (`psycle.wingfield.tech`) is behind Cloudflare Access (email-PIN /
Google login). The calendar feed will NOT work through it.** Apple/Google calendar
fetchers are headless: they can't complete the Access login, send no session
cookie, and would receive Cloudflare's login HTML instead of `text/calendar`. The
subscription would silently fail / show an empty or broken calendar.

**Required infra change:** add a Cloudflare Access **Bypass** policy (or a path
exclusion on the Access application) for **`/api/calendar/*`** so that path is
served straight through to the origin. Our per-user rotatable token (§7) is the
auth for that path instead of Access.

- This is the *only* path that needs exempting. Everything else stays behind
  Access.
- Because the path is now publicly reachable, compensate with: a Cloudflare WAF
  rate-limit rule on `/api/calendar/*`, plus the app-level limiter and `410` on
  revoked tokens already planned.
- The enable/disable/rotate/status routes (§9) stay **inside** Access — they're
  called from the authenticated app, so no change there.

**Push notifications are unaffected.** Push delivery never traverses the origin
through Access: our server → push service (FCM/APNs/Mozilla) → device, over the
Web Push protocol. The only Access-protected call is `/api/push/subscribe`, which
runs inside the already-authenticated app. No Access change needed for push.

---

## 8. Onboarding step

Insert a new step **after `notifications`, before `spotmaps`** in
`onboarding.js`'s `STEPS` array. Per the brief it **must not require the PWA to be
installed** (unlike push) — a subscribed calendar works in any browser context, so
this step always runs (only skipped if the user already enabled the feed).

```
STEPS = ['intro', 'install', 'login', 'notifications', 'calendar', 'spotmaps']
```

`stepCalendar(ctx)`:
- Headline: "Add your classes to your calendar."
- One-line value prop + the honesty note ("Your booked classes appear in Apple
  or Google Calendar and stay in sync automatically.").
- Buttons: **Add to Apple Calendar**, **Add to Google Calendar** (platform-aware:
  lead with Apple on iOS, Google elsewhere; show both + "copy link").
- Secondary: **"Skip"** / **"Set up later"** (resolve without enabling).
- Tapping a subscribe button first calls the enable endpoint (mint token, flip
  setting on) *then* opens the `webcal://` / Google link.
- Mirror the existing step visual language (`renderSheet`, themed icons). Add a
  `calendar` icon to the `ICON` map.

Resumability: same pattern as other steps (persisted via `STEP_KEY`); skipped if
`settings.calendar.enabled` is already true.

---

## 9. Server-side changes summary

**New files**
- `server/calendar.js` — ICS serialization (VEVENT/VTIMEZONE builders, escaping
  per RFC 5545: fold lines at 75 octets, escape `,;\\` and newlines), snapshot
  generation, the hourly cron, precedence/dedupe resolver.

**`db.js`**
- `users.calendar_token TEXT` (nullable) — migration via `ensureColumn`.
- New `calendar_snapshots` table: `user_id` (unique), `ics TEXT`, `etag TEXT`,
  `class_count INT`, `generated_at TEXT`, `sequences TEXT` (JSON `{eventId: seq}`
  for change-detection / `SEQUENCE` bumping).
- New `waitlist_cache` table (**locked**, mirrors `booking_cache`): `user_id`,
  `event_id`, `start_at`, `class_name`, `group_name`, `instructor_name`,
  `studio_name`, `location_name`, `synced_at`, `UNIQUE(user_id, event_id)`. Plus
  `replaceWaitlistCache(userId, list)` / `getWaitlistCacheForUser(userId)` /
  `pruneWaitlistCache(beforeISO)`.
- `server_kv` key `locations_json` — long-TTL location→address cache (§3.1).
- Helpers: `getCalendarToken/setCalendarToken/rotateCalendarToken`,
  `getCalendarSnapshot/saveCalendarSnapshot`, `getUsersWithCalendarEnabled`.

**`server.js`** (new routes)
```
GET    /api/calendar/:token.ics      # public-by-token, ETag/304/410, text/calendar
POST   /api/calendar/enable          # auth; mint token if absent, set enabled, return links
POST   /api/calendar/disable         # auth; revoke token, set disabled
POST   /api/calendar/rotate          # auth; new token, return links
GET    /api/calendar/status          # auth; {enabled, token, lastGeneratedAt, classCount, links}
```

**`poller.js` / startup**
- Register the **hourly** cron `0 * * * *` (single job, all calendar-enabled
  users) — house it in `calendar.js` `init()`, called from `server.js` alongside
  `poller.init()`. This job also fetches `/bookings` + `/waitlists` per user and
  refreshes both caches, **replacing** the standalone 6-hourly
  `refreshBookingCaches()` (fold it in so CodexFit isn't double-polled).
- Warm one snapshot pass shortly after boot.
- Trigger an **immediate** `regenerateSnapshot(userId)` (DB-only, no CodexFit
  call) right after events that change a user's classes: Auto-Book success,
  Auto-Upgrade success, in-app cancel/book via proxy hook, manual waitlist
  join/leave, `bookings/sync`. Data is current within seconds; the device sees it
  on its next poll.

**Infra:** Cloudflare Access **Bypass** policy on `/api/calendar/*` + WAF
rate-limit rule (see §7). This is a console/Terraform change, not code.

**Settings shape** (`settings.calendar`)
```jsonc
{
  "calendar": {
    "enabled": false,
    "includeTentative": false   // the §6 toggle
  }
}
```
(Token lives on `users`, not settings, so it isn't exported via config export.
Title/description formats are fixed per §5 — no emoji toggle.)

**Config export/import:** exclude the calendar token (secret). The `enabled` /
`includeTentative` prefs can be exported safely.

---

## 10. Client-side changes summary

- `client/src/api.js` — `enableCalendar()`, `disableCalendar()`,
  `rotateCalendarToken()`, `getCalendarStatus()`.
- `client/src/ui/settings.js` — new **Calendar** card (subscribe buttons,
  include-tentative toggle, status line, off switch) + a `renderCalendarCard()` /
  wiring akin to `renderNotifPrefs()`.
- `client/src/ui/onboarding.js` — new `calendar` step (§8).
- `index.html` — Calendar settings card markup + (optional) a small modal for
  "choose your calendar app".
- `styles.css` — reuse existing card/button classes; add a calendar icon. No new
  design system (per DESIGN.md; product is "Psycle Assistant").
- Platform-aware subscribe button helper (iOS → Apple first; detect via the same
  `isIOS()` used in onboarding).

---

## 11. Edge cases & decisions to confirm

- **Multi-spot class** → one VEVENT, `Bikes: 3, 4`. ✓ (group `booking_cache` by
  `event_id`).
- **Auto-Book that fails** → tentative event disappears on next snapshot (correct,
  matches "removed automatically").
- **Past classes** → keep for a 24h trailing window then drop, so today's history
  isn't yanked mid-day.
- **Timezone** → always `Europe/London` `VTIMEZONE`; never bare `new Date()` (same
  rule as the rest of the app, Luxon already in use).
- **Dev mode (`dev@psycle.com`)** → generate from mock data so the feed is testable
  without CodexFit.
- **Empty feed** → still emit a valid `VCALENDAR` with zero events (don't 404; an
  empty calendar is valid and keeps the subscription alive).
- **Token leak** → rotate; old URL 410s.
- **Google caching** → Google can lag many hours; set expectations in copy, can't
  fix server-side.

### Decisions — resolved

1. ✅ **Tentative default:** off (confirmed-only). Toggle copy locked (§6).
2. ✅ **Waitlist scope:** invest in `/waitlists` caching now — covers manual +
   Auto-Book-fallback waitlists (§3.2).
3. ✅ **Cadence:** hourly background (single all-user job) + immediate on in-app
   actions (§2).
4. ✅ **Location addresses:** cached server-side, very long TTL (§3.1).
5. ✅ **Title/description:** formats locked per §5 (no emoji toggle).
6. ✅ **Cloudflare Access:** Bypass policy required on `/api/calendar/*` (§7).

### Still open

- **`VALARM`:** leave off (push owns reminders) as proposed, or offer an optional
  calendar alarm too? *(Recommend leave off for v1.)*

---

## 12. Rough effort estimate

| Piece | Effort |
|---|---|
| `calendar.js` ICS serializer + VTIMEZONE + escaping | M |
| Snapshot table + hourly cron + event-driven regen hooks | M |
| `waitlist_cache` table + `/waitlists` poll + in-app hooks | S–M |
| Feed endpoint (token auth, ETag/304/410, rate limit) | S |
| Enable/disable/rotate/status routes + token column | S |
| Location address fetch+cache (§3.1) | S |
| Settings card (subscribe links, toggle, off switch) | M |
| Onboarding step | S |
| Cloudflare Access bypass + WAF rule (infra, not code) | XS |
| Dev-mode mock feed + testing across Apple/Google | M |

**Overall: Medium.** No new external dependencies required (ICS can be
hand-rolled; Luxon already present for TZ). The biggest real-world cost is
cross-client testing (Apple vs Google vs Outlook all parse `.ics` slightly
differently) and the address/waitlist data gaps, not the core serialization.
