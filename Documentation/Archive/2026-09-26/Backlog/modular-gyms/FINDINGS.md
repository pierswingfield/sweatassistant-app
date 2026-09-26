# Asymmetry findings — the original audit trail

Archived 2026-09-02 from OUTSTANDING.md, which is now the forward-looking handoff.

**Not actionable.** This is the "why is it like this?" record: what each of the eight
asymmetries actually was, what it would have broken, and how it was closed. Useful when a fix
looks arbitrary and you want to know what it was defending against.

---

# Outstanding work — multi-gym & JAB Boxing readiness

**What has to be true before `gyms.config.js` sets `jab-boxing: enabled: true`.**

Re-planned **2026-08-31** under the symmetric framing (see below). Every claim was verified by
reading the source, not recalled. Re-verify before trusting it; commands are at the bottom.

For per-work-package status see [PROGRESS.md](./PROGRESS.md); for the plan and acceptance
criteria see [PLAN.md](./PLAN.md). This file answers "is JAB ready?" in one read.

---

## The test this plan is written against

> **Delete `psycle-london` from `gyms.config.js`. Nothing outside `providers/codexfit.js`
> should break.**

This replaces "does JAB work?" as the acceptance criterion, and it is a materially harder bar.
"Does JAB work?" is satisfied by adding a MarianaTek branch beside each CodexFit assumption —
which leaves Psycle as the base case and the next gym as another branch. **The purpose of this
phase is not to bolt MarianaTek onto CodexFit; it is to make every gym an equal upstream
service.**

Practical corollary, and the thing to check work against:
**adding a third gym should require zero edits outside `providers/` and `gyms.config.js`.**

### Three layers, not two

The distinction that keeps the corollary true (stakeholder, 2026-08-31):

| Layer | What lives here | Scope |
|-------|-----------------|-------|
| **Platform module** — `providers/codexfit.js`, `providers/marianatek.js` | The **protocol**: how to authenticate, fetch a timetable, read a layout, book a spot, and *where* this platform exposes things like release times, credit types and profile metadata | Shared by every tenant on that platform |
| **Gym config** — an entry in `gyms.config.js` | The **instance and its policy**: URLs, client IDs, theme, capability flags — and per-gym behaviour such as the booking-window rule, credit-type mappings and membership tiers | One gym |
| **App** — everything above `providers/` | Normalized types and capability flags only. Knows no platform and no gym | Universal |

MarianaTek is a platform used by many gyms, JAB being one. So is CodexFit, Psycle being one.
**A rule that is true of Psycle but not of every CodexFit gym belongs in the gym config, not in
the platform module** — every gym has a booking window, many instructors and class types, credit
systems with types and metadata, profile metadata, membership levels, multiple locations and
spot maps across multiple studios. What differs between them is policy, not the existence of the
concept.

---

## Verdict: not ready

Read as asymmetries rather than as JAB bugs, the work regroups into **8 layers** — and one layer
appears that symptom-hunting missed entirely, because it produces no visible failure: **the data
layer silently files every row as Psycle.**

The estimate also grows. Scoped as "migrate the client off the proxy" the client work was 3–4
days. Scoped as "no raw provider shape anywhere in the client" it is **82 sites across 9
modules**, and closer to two weeks.

Unchanged: the adapter layer is finished (16/16 methods), the dependency ordering holds, and the
`user_gyms` schema gap still goes first.

---

## The eight asymmetries

Grouped by **where the privilege lives**, not by symptom. `SILENT` = wrong data or wrong timing
while looking healthy. `HARD` = visible error.

### A — The data layer files every row as Psycle — ✅ **DONE** (WP-D6, 2026-08-31)

The DDL defaults are gone from all seven gym-scoped tables, so a forgotten `gym_id` is now
`NOT NULL constraint failed` rather than a silent Psycle row. ~20 per-user accessors scope to
`resolveActiveGymId(userId)`; the three cross-user background scanners are deliberately left
unfiltered. `markAutoBookingExecuted` takes an explicit `gymId` from the row it is executing.
The settings blob is split into `account_settings` (the person) and `settings` (per gym),
merged transparently so no caller changed. 16 checks in `server/test-gym-isolation.js`.

**Scope note:** the audit said "4 literal writes". It was ~35 query sites, and most of the
*reads* were unscoped too — `getStudioPreferences`, `getBookingCacheForUser`,
`getCalendarClasses`, `getUserAutoBookings`, `getUserAutoUpgrades` all filtered on `user_id`
alone. Since several of these tables key on **provider** ids, an unscoped read meant Psycle
studio 138's spot map could be handed to a JAB booking.

**Two invariants to keep** (both pinned by tests, both easy to break by reflex):

1. Per-user accessors scope to the active gym. Cross-user background scanners **must not** —
   filtering those to the active gym silently stops background work for every other gym.
2. Settings default to **gym**-scoped; only keys in `ACCOUNT_SCOPED_SETTING_KEYS` are shared.
   The default runs this way because the gym-scoped set is the one that grows, and a missed
   gym key leaks silently while a missed account key merely gets set twice.

<details><summary>Original finding (kept for the "why is it like this?" trail)</summary>

### A — The data layer files every row as Psycle — SILENT *(new, missed by both passes)*

Five tables carry a **column default of `'psycle-london'`**, so an insert that omits a gym does
not error — it silently becomes a Psycle row. Four `db.js` call sites then write that literal
outright. A JAB user's spot maps, settings and calendar rows would all be filed under Psycle.

```
DDL default (a forgotten gym_id lands as Psycle, silently):
  studio_preferences · settings · booking_cache · waitlist_cache · calendar_classes
  gym_id TEXT NOT NULL DEFAULT 'psycle-london'

literal writes:
  db.js:815    setStudioPreference   INSERT ... DEFAULT_GYM_ID
  db.js:829    setUserSettings       INSERT ... DEFAULT_GYM_ID
  db.js:1070   calendar_classes      INSERT ... DEFAULT_GYM_ID
  db.js:902    listUsers (admin)     JOIN ... ON gym_id = DEFAULT_GYM_ID
```

In-code these are marked deferred to "WP-D4", so the debt was known — but it is in neither
backlog list, and symptom-hunting could never surface it: writing to the wrong gym's row throws
nothing.

**Symmetric fix:** drop the DDL defaults and make `gym_id` a required argument. A missing gym
should be a loud failure, not a quiet Psycle row. Drop the default *first* — every remaining
unthreaded write then becomes a test failure that names itself.

</details>

### B — The caller picks the provider, at import time — ✅ **DONE** (WP-D7, 2026-08-31)

All six import-time provider constants are gone. Resolution is per-request (the caller's active
gym) or per-row (`row.gym_id`) — the latter matters because background work must run for a gym
the user isn't looking at. `triggerAutoRelogin(userId, gymId?)` takes a gym and delegates the
credential ladder to `provider.refreshSession(session, credentials)`, so the caller never learns
which platform has refresh tokens. All 12 hardcoded `psycle.codexfit.com` URLs became paths that
the provider prepends its own base to; the only hostname left in the tree is in
`gyms.config.js`. `calendar.js` uses `fetchEventDetails` instead of parsing CodexFit's
`relations` envelope.

Two things fixed along the way that were not in the finding:

- **MarianaTek's `refreshSession` didn't implement its own contract.** It threw when there was no
  refresh token, and again when one was *rejected* — the commoner case — instead of descending to
  the re-login rung the interface documents. A revoked token was an unrecoverable lockout while
  we held working credentials.
- **`NormalizedEvent` had no `durationMin` or `locationAddress`**, which is why calendar.js was
  parsing raw CodexFit at all. Both are universal concepts, so they went on the type rather than
  becoming a CodexFit special case.

**The acceptance criterion is now itself a test** — `server/test-no-gym-privilege.js` fails on a
module-level provider const, a `getProvider('literal')`, a hardcoded provider hostname, or an
identifier named after one platform. Mutation-tested: all four regressions are caught.

<details><summary>Original finding (kept for the "why is it like this?" trail)</summary>

### B — The caller picks the provider, at import time — HARD *(was B1 + B2 + B9)*

Six modules resolve a provider once, at require time, to Psycle — **including the login path
itself**. Nothing re-resolves per user.

```
server/scheduler.js:11   const codexfit = getProvider('psycle-london');
server/poller.js:12      const codexfit = getProvider('psycle-london');
server/calendar.js:22    const codexfit = getProvider('psycle-london');
server/admin.js:12       const codexfit = getProvider('psycle-london');
server/server.js:24      const codexfit = getProvider(DEFAULT_GYM_ID);
server/auth.js:30        getProvider(DEFAULT_GYM_ID).login(...)   // handleLogin

provider behaviour hardcoded outside the adapter:
  auth.js            triggerAutoRelogin() — no gymId, CodexFit-only login, ignores
                     MT's refreshSession() and refresh token; on failure nulls the
                     JWT → lockout
  calendar.js:66,108 https://psycle.codexfit.com/... hardcoded
  calendar.js:85     parseEventDetail() parses CodexFit's `relations` envelope
```

**Symmetric fix:** remove the concept of a module-level provider — not "add a `gymId` parameter
to the CodexFit path". The request carries its gym; the module holds none. Rename with it:
a variable called `codexfit` holding an arbitrary provider is how the next asymmetry gets
written. Same for `fetchCodexFit()` and `loginToCodexFitAPI()`.

</details>

### C — A gym link cannot hold its own identity — ✅ **DONE** (WP-D5, 2026-08-31)

`user_gyms.gym_email` now holds the address this account authenticates to *that* gym with,
stored by `linkGymAccount()` (lower-cased) alongside the password. Exposed as `user.gym_email`
via `mergeUserWithGym` and on `getUserGymsPublic`. Migration is idempotent; existing
`psycle-london` links backfilled from `users.email` (provable — pre-D4 an SA login *was* a
CodexFit login), links to any other gym left NULL rather than guessed.

**The invariant to keep:** NULL means "cannot re-authenticate unattended", and must **never**
fall back to `users.email`. That fallback works for every account that exists today and would
silently restore the coupling D4 removed. Pinned by `server/test-gym-identity.js` (10 checks).

### D — The client speaks CodexFit natively — 🟡 **ONE BIG PIECE LEFT** (WP-D9/11/12/13)

> **Correction, 2026-09-02.** This was marked "functionally complete" on the strength of the
> proxy-call count reaching 4. That count was measuring the wrong thing. Loading the app as a
> JAB user immediately threw:
>
> ```
> TypeError: Cannot read properties of undefined (reading 'split')
>   at renderTimetableGrid (timetable.js:803)   // e.start_at.split('T')
> ```
>
> The cause is one line, `timetable.js:304`:
>
> ```js
> freshEvents = normalizedEvents.map((ne) => ne.raw).filter(Boolean);
> ```
>
> The timetable fetches normalized events and then **throws them away in favour of `.raw`** — the
> provider's own payload — so every read below it is raw CodexFit (`start_at`, `event_type`,
> `studio_id`, `capacity`, `occupancy`, …). ~90 such reads. It works for Psycle because `.raw`
> *is* a CodexFit event; for MarianaTek `.raw` is an MT class with `start_datetime`, and the grid
> dies on the first one.
>
> Migrating the proxy CALLS was necessary but not sufficient: the client stopped calling CodexFit
> paths while still consuming CodexFit shapes. **The timetable grid is the last and largest piece
> of layer D**, and it is the difference between "JAB loads" and "JAB doesn't".


**Slice 1 done (2026-09-01): the metadata lists.** `GET /api/metadata` returns
locations/studios/instructors/classTypes in one normalized shape. CodexFit builds it from its
four dedicated endpoints; **MarianaTek derives all four from its class list**, having none of
them (Q12 — this was blocker B6). The client's four raw proxy reads became one call, and every
consumer moved off the raw CodexFit shape.

The migration hazard worth recording: **normalized ids are strings, raw event fields are
numbers**, so every `metadata.studios.find(s => s.id === e.studio_id)` was silently false rather
than throwing. All of them now go through a `sameId()` helper. Same class of trap for
`full_name`→`name`, `group.name`→`group` (now a plain string), `location_id`→`locationId`, and
`layout.slots.length`→`hasLayout`.

One honest consequence of deriving lists from classes: for MarianaTek they describe **what is on
the timetable**, not everything the gym has. An instructor with no upcoming classes won't appear
as a filter option. That is what a timetable filter wants, but it is not the same guarantee
CodexFit's dedicated endpoints give.

**Slice 2 done (2026-09-01): the write paths.** book / cancel / waitlist join+leave and the
bookings+waitlists reads are all on normalized routes. Down from 34 proxy sites to **13**.

Three things this slice settled that are worth keeping:

- **`bookSlot` books ONE spot per call**, by contract. MarianaTek's `POST /me/reservations` takes
  a single `spot: { id }`; CodexFit could batch, but a contract shaped around CodexFit would be
  unimplementable for MT. Callers loop, and the two multi-spot client flows now report partial
  success rather than implying everything landed.
- **Commands throw; `book` does not.** `cancel`/`joinWaitlist`/`leaveWaitlist` return `{ ok }`
  from the server but throw in `api.js`, because every caller was written against a proxy that
  threw — returning a flag would have rendered a success toast on a failed cancel. `book` stays
  non-throwing: a decline carries information the caller needs.
- **`bookedAt` joined `NormalizedBooking`** — it drives the 60-second free-cancellation countdown
  and was the last reason `bookings.js` reached for a raw CodexFit field.

**Slice 3 done (2026-09-01): profile, credits, and the credit arithmetic.** Down to **11** sites.

The find worth recording: `getAvailableCreditsForEvent` was duplicated in **four** modules, and
every copy returned **0** when the account had no credit inventory. Zero is not "unmetered", it
is "you cannot book" — `maxBookableSlots = Math.min(available, 0)` would have disabled booking
entirely for a membership gym. This was a live JAB blocker hiding inside what looked like
harmless duplication. There is now one copy, and a **`metered`** capability separating "charges
per class from a balance" from `creditPurchase` ("we can sell top-ups") — a gym can be one
without the other.

**Slice 4 done (2026-09-01).** Event details, settings' profile, and settings' studio+location
lists are all normalized. **34 → 4 proxy sites.**

**The remaining 4 are not normalization targets — they are layer F's job**, and building
normalized routes for them would be inventing cross-gym concepts that do not exist:

| Site | Why it stays | Gate |
|---|---|---|
| `timetable.js` bookmarks ×2 | CodexFit profile metafields; MarianaTek has no bookmarks API | `capabilities.bookmarks` |
| `credits.js` `/bundles` | Credit packs to buy; JAB is membership-based | `capabilities.creditPurchase` |
| `settings.js` `/account/update` | Konami-gated debug writer of arbitrary raw provider fields. "Edit any profile field" is not a universal concept | debug-only, CodexFit-only |

So layer D is **functionally complete**: every path a JAB user would actually take is normalized.
`/api/proxy` can be deleted once those four are capability-gated out of existence in layer F —
which is the honest sequencing, since three of them should simply never render for JAB. The bookmark pair should be
**capability-gated rather than migrated** (`bookmarks: false` for JAB — that is layer F's job).
Then `/api/proxy` gets deleted, which is the proof this layer is finished.

<details><summary>Original finding (kept for the "why is it like this?" trail)</summary>

### D — The client speaks CodexFit natively — HARD *(was B4 + B6, ~2× larger)*

Two problems the retrofit framing conflated. **34 `api.proxy*` call sites** route through a
CodexFit-shaped passthrough — and behind them, **82 sites read raw CodexFit object shapes
directly** (`metafields`, `available_credits`, `credit_types`, `event_type.group.name`,
`.relations`, `.layout.slots`).

```
raw provider shapes, by module:
  timetable.js  25    bookings.js   19    settings.js  14
  autobook.js    7    autoupgrade.js 6    tooltips.js   5
  main.js        3    credits.js     2    lib.js        1     → 82

no normalized list route exists for:
  studios · locations · instructors · class types
  (MarianaTek has no studios endpoint — derive from upcoming classes)
```

Migrating the 34 without de-shaping the 82 produces a client that calls gym-agnostic routes and
then reaches into the response for CodexFit fields. That passes "does JAB work?" by accident and
fails the test at the top of this file.

**Symmetric fix:** `/api/proxy` gets **deleted, not shimmed** — its deletion is the proof this
step is finished. The client holds no provider shape at all; everything it renders comes from a
`Normalized*` type.

</details>

### E — Psycle's booking-window model lives in shared code — ✅ **DONE** (WP-D8, 2026-08-31)

Split across the three layers exactly as the reframe required:

- **`gyms.config.js`** — `psycle-london.bookingWindow` holds the policy (Monday, 12:00, 14-day
  base, 1–35 clamp, credit type 8 with a 15-day floor). `jab-boxing` declares
  `{ kind: 'per-class' }` and states no rule, because it has none.
- **`providers/booking-window.js`** — evaluates a policy. Platform- and gym-agnostic, so any
  gym on any platform that releases on a fixed weekday can use it.
- **`providers/codexfit.js`** — the protocol half only: where CodexFit exposes
  `booking_cutoff` / `extended_cutoff` / `extended_booking_allowed`. No Psycle numbers.
- **`routes-normalized.js`** stamps `releaseAt` on every event; the client reads a timestamp
  and computes nothing. `auto_bookings.release_at` stores it at queue time, because a
  per-class gym has no rule to recompute it from later.

**Equivalence is proven, not assumed.** A 10,000+ case sweep compares the composed result to
the shipped algorithm (reimplemented verbatim in the test, not imported) across every day of a
year × every membership tier × three times of day, plus both BST transitions. Bit-identical.

**The test found a leak I had missed:** `Europe/London` was still hardcoded in five places in
`codexfit.js`. CodexFit serves timezone-naive datetimes, but *which* zone they are naive in is a
property of the gym — a CodexFit gym in New York would need `America/New_York`. `timezone` is
now a gym-config field.

**Model corrected 2026-09-01 (stakeholder).** The first cut had two kinds; there are three, and
they are different shapes rather than variants:

| kind | rule | gym |
|---|---|---|
| `rolling-weekly` | fixed weekday + hour, plus a **per-member** day offset from their profile cutoff | Psycle |
| `rolling-continuous` | class start − a fixed span, **exact to the minute**; uniform across members | JAB |
| `per-class` | the API publishes the resolved instant | JAB (MarianaTek resolves either rule server-side) |

JAB is `per-class` for reads — confirmed: MT publishes `booking_start_datetime`, already resolved
for the viewing account, matching `booking_window_display: "Reserve 14 days in advance"` on two
production captures. Its `fallback` is `rolling-continuous / 14d`, used only if the field is
absent.

**The dangerous bit that got fixed:** the first cut treated a per-class gym with no published
release as *open now*. That would have fired auto-book on a class weeks before its window and
burned the queue entry. It now resolves to **null**, and all four scheduler call sites treat null
as "skip" rather than dispatching on a guess.

**UX follows the model:** the Auto-Book tab now carries a release instant per card
(`data-release-at`) and the banner counts to the soonest queued release, replacing a single
hardcoded Monday-noon countdown. On a rolling-continuous gym two classes on the same day open at
different times, so no single "next release" exists to count to.

**Remaining, deliberately:** `client/src/lib.js` still contains `detectBookingWindow()`, which
duplicates the server's `resolveBookingWindow()` and persists `detectedBookingOffset`. It is no
longer on the correctness path (the server stamps `releaseAt`), but it is Psycle policy in
client code and should move server-side. Also `getClassReleaseTime()` keeps the old Monday-noon
computation as an explicit legacy fallback for events cached before D8; remove once the client
cache has rolled over. **No client test harness exists — the client half of this needs a browser
check before deploy.**

<details><summary>Original finding (kept for the "why is it like this?" trail)</summary>

### E — Psycle's booking-window model lives in shared code — SILENT *(was B5, fix shape changed)*

```bash
grep -c releaseAt server/scheduler.js server/poller.js client/src/lib.js   # → 0 0 0
```

populated `marianatek.js:408` · carried `normalize.js:23` · ignored by `lib.js
getClassReleaseTime()` and `scheduler.js:112`, both hardcoded to `weekday: 1, hour: 12`.
Roughly **130 lines of Psycle window logic sit in shared client code** — `getBookingOffset`,
`detectBookingWindow`, `weeksToOffsetDays`, `getMostRecentReleaseMonday`,
`ADVANCED_BOOKING_CREDIT_TYPE_ID`.

**This is where the reframe changes a technical decision.** The first plan said "consume
`releaseAt`, fall back to Monday-noon when absent." That fallback *is* the extension-of-Psycle
pattern in miniature: it makes Psycle's model the universal default and every other gym an
override.

**Symmetric fix:** every gym publishes `releaseAt`; the client reads a timestamp and computes
nothing.

But the ~130 lines do **not** simply move into `providers/codexfit.js` — that would put Psycle
*policy* into the CodexFit *platform module*, and be wrong for the next CodexFit gym, which
might release Sundays at 09:00. Split along the three layers above:

- **`providers/codexfit.js`** — protocol: read `booking_cutoff` / `extended_cutoff` /
  `extended_booking_allowed` off the profile, and the credit inventory. It knows *where* CodexFit
  exposes these, not what they mean for a given gym.
- **`gyms.config.js` → `psycle-london`** — policy: `bookingWindow: { release: 'weekly',
  weekday: 1, time: '12:00', tz: 'Europe/London', creditFloorDays: 15, creditTypeId: 8 }` or
  similar. JAB needs no equivalent — its policy is "the API tells you per class".
- **The adapter composes them** into `NormalizedEvent.releaseAt`.

`test-booking-window.js`'s equivalence guard moves with the logic; it should end up asserting
that the composed `releaseAt` matches today's Psycle values for a set of fixture profiles.

</details>

### F — The UI assumes CodexFit's feature set and vocabulary — HARD *(was B7 + B8 + B10)*

```bash
grep -rn capabilities client/src/ | grep -v api.js    # → no matches
grep -n swapSpots server/poller.js                    # → no matches
grep -n layoutFormat client/src/ui/timetable.js       # → no matches
```

- renders + fails: Buy Credits (`index.html:151`, `creditPurchase: false`), Bookmarked filter
  (`timetable.js:405`, `bookmarks: false`)
- loses the spot: poller cancel-then-rebooks; MT implements atomic swap at `marianatek.js:557`
  and auto-fills its own waitlist, which the poller double-acts against
- books `undefined`: `timetable.js:1941` `bookSeatDirect(c.id, availableSlots[0])`.
  `bookings.js:406` and `autobook.js:543` check `layoutFormat`; the main booking surface does
  not. Psycle is always pick-a-spot, so this never surfaced.

**Symmetric fix:** the UI renders from capabilities, not from a gym name — **including Psycle's**.
Every non-universal feature is gated the same way for both gyms, so a third gym gets the right UI
with no client edit. Same for behaviour: pick the upgrade mechanism from `atomicSwap` /
`nativeWaitlist` rather than hardcoding cancel-then-rebook as the default.

### G — Runtime state is not isolated between gyms — SILENT *(was B11 + new)*

```
scheduler.js:29-30   claimedSlots / burnedSlots — key: eventId + slotId, no gym
server.js:370        'Auto-book queue limit reached (15 pending entries)'  — global

client cache — mitigated, but by discipline rather than design:
  cache key prefix is the user id, not the gym (cache.js:19)
  settings.js:1047  applyGymSwitch() clears the whole API cache — correct, but
                    correctness depends on remembering to call it
  psycleDefaultFilters  NOT cleared — saved location/instructor/class-type filters
                    survive a gym switch and reference the old gym
```

**Symmetric fix:** put `gymId` in the keys rather than clearing state on transitions — make
collisions impossible instead of remembering to avoid them.

### H — No MarianaTek booking has ever succeeded live *(was B12, unchanged)*

Write paths are mock-verified only (`dev@jabboxing.mock` → `mock-marianatek.js`). Error paths
were live-tested; success paths are a well-modelled assumption. The JAB test account has no
credits and no membership. **The only item that cannot be closed by writing code.**

---

## Styling, re-read symmetrically

Costs almost nothing — the token layer is already clean. The asymmetry is in *who is the
default*, not in the plumbing.

**Already symmetric:**

- All 3 theme states with full light/dark parity (`styles.css:13 / 117 / 182`).
- **Only 2 inline hardcoded colours** in ~8,970 lines of client UI JS. Everything else resolves
  through `var(--…)`, so a per-gym palette is a token-override block, not a sweep.
- `NormalizedEvent.discipline` **already exists and both adapters populate it**
  (`codexfit.js:387`, `marianatek.js:405`) — the fix below is half-built.

**Where Psycle is still the default:**

- **0** occurrences of `data-gym` anywhere. JAB's configured `navy / #18214D / Gothic A1` is
  served and read by nothing — while Psycle's palette *is* the base token set. Symmetric version:
  the base is gym-neutral and **every** gym including Psycle supplies overrides.
- **7×3** discipline tokens, all Psycle. Worse, `cards.js getDiscipline()` **regex-matches class
  names** (`/ride|cycle|spin/`, `/barre/`, `/reformer|pilates/`) instead of reading the
  normalized `discipline` field already on the event. Every JAB class falls to "other".
- **7** `font-family` declarations hardcode `'Inter'`/`'Outfit'` instead of `var(--font-sans)`,
  one `!important` (`styles.css:2800`). No gym's font reaches those elements.
- **55** raw hex values outside the token blocks — invisible to any override, in either direction.
- **18** user-facing "Psycle" strings (8 client copy, 8 push titles `notifications.js:71–114`,
  2 calendar feed). Should read the active gym's name for *every* gym.
- **466** inline `style="…"` attributes, ~994 `.psycle-` prefixes — real debt, neither blocks
  symmetry. **Leave them.**

---

## Already symmetric — don't redo

- **The adapter layer is done.** MT implements all 16 `GymProvider` methods + `getCredits` /
  `getMemberships`. The seam is genuinely symmetric; the problem is entirely above it.
- **`resolveActiveGymId()` is well-built** — request gym → stored choice → sole link → default,
  request gym scoped to its own user. Its step-4 tie-break prefers Psycle (`db.js:541`) but only
  for a multi-link account that has never chosen. Defensible; not worth effort.
- **Rollout gates correct.** `setActiveGym()` and `linkGymAccount()` both refuse a disabled gym;
  `resolveActiveGymId()` deliberately doesn't consult `enabled`.
- **Account / gym-linking spine.** Switcher `settings.js:1022–1220`, connect-a-gym screen
  `main.js:951`, `x-gym-id` header, D4 local auth, `NO_GYM_LINKED` as a first-class state.
- **MT dev mock wired** at adapter level via `dev@jabboxing.mock`.
- **9/9 server test suites pass** (run 2026-08-31): adapters 32/32, active-gym 21/21,
  account-identity 17/17, booking-window 8/8, MT mock 12/12, plus routes-normalized,
  psycle-regression, poller-upgrade, calendar-feed.

---

## Order of work

Dependency chain, not priority ranking. **~3–3.5 weeks** total, plus a funded JAB account in
parallel. Estimates assume one developer fluent in this codebase.

1. ~~**Give a gym link its own identity.**~~ ✅ **DONE 2026-08-31** — `user_gyms.gym_email`,
   idempotent migration + default-gym-only backfill, stored by `linkGymAccount()`.
   `server/test-gym-identity.js`, 10 checks. *(layer C)*
2. ~~**Make the data layer refuse to guess.**~~ ✅ **DONE 2026-08-31** — seven DDL defaults
   dropped, ~20 accessors scoped, settings split into account + gym stores.
   `server/test-gym-isolation.js`, 16 checks. *(layer A)*
3. ~~**Remove module-level providers and the names that encode them.**~~ ✅ **DONE 2026-08-31** —
   six consts removed, gym-aware relogin, 12 hardcoded URLs → paths, calendar on the adapter,
   renames done. `server/test-no-gym-privilege.js`, 6 checks. *(layer B)*
4. ~~**Split the booking-window model across protocol and policy.**~~ ✅ **DONE 2026-08-31** —
   policy in `gyms.config.js`, evaluator in `providers/booking-window.js`, protocol in the
   adapter, `releaseAt` stamped server-side. `server/test-booking-window-policy.js`, 15 checks
   incl. a 10k-case equivalence sweep. *(layer E)*
5. **De-shape the client, then delete the proxy** — *~1.5–2 weeks.* Add the normalized list
   routes, move all 34 call sites, remove all 82 raw-shape reads, then delete `/api/proxy`.
   Verify in a browser before deleting the shim. *(layer D)*
6. **Render from capabilities, for every gym** — *~2 days.* Capability gates, swap/waitlist
   mechanism selection, FCFS branch; `data-gym`, Psycle's palette out of the base token set,
   per-gym fonts, `cards.js` onto the normalized `discipline`, the 18 strings. *(layer F +
   styling)*
7. **Key runtime state by gym** — *~half a day.* Claim/burn keys, quotas, client cache prefix,
   `psycleDefaultFilters`. *(layer G)*
8. **Verify a real booking on a funded JAB account** — blocked on access, runs in parallel, gates
   the flip regardless of code readiness. *(layer H)*
9. **Run the test, then flip.** Comment out `psycle-london`, confirm nothing outside
   `providers/codexfit.js` breaks, then `enabled: true` at `gyms.config.js:50` — ideally behind a
   per-user allowlist. *(WP-T4)*

Also outstanding, not gating: **WP-X1** (fold plan outcomes into AGENTS.md).

---

## Verifying this file is still accurate

```bash
# A — does the data layer still guess?
grep -n "DEFAULT 'psycle-london'" server/db.js
grep -n "DEFAULT_GYM_ID" server/db.js

# B — module-level providers, and the names that encode them
grep -n "getProvider(" server/*.js | grep -v test-
grep -rn "codexfit\|CodexFit" server/*.js | grep -v providers/ | grep -v test-

# C — can a gym link name itself?
grep -n "CREATE TABLE IF NOT EXISTS user_gyms" -A 20 server/db.js

# D — raw proxy calls, and raw provider shapes
grep -rc "api\.proxy" client/src/ui/*.js client/src/*.js
grep -rc "metafields\|available_credits\|event_type?\.\|\.relations\|credit_types" client/src/ui/*.js

# E — is releaseAt universal yet?
grep -c releaseAt server/scheduler.js client/src/lib.js
grep -n "getBookingOffset\|detectBookingWindow" client/src/lib.js

# F — capabilities, swap, FCFS, discipline
grep -rn capabilities client/src/ | grep -v api.js
grep -n "swapSpots" server/poller.js
grep -n "layoutFormat" client/src/ui/timetable.js
grep -n "getDiscipline" client/src/ui/cards.js

# G — gym-keyed runtime state
grep -n "claimKey" server/scheduler.js
grep -n "keyPrefix" client/src/cache.js

# the test itself
grep -n "enabled" server/gyms.config.js
```
