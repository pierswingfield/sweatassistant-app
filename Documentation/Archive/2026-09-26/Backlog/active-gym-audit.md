# "Active gym" audit — 2026-09-15

**The finding in one line: the client was migrated off the active-gym model, the server was
not, and the server's silent fallback is now the single largest source of cross-gym bugs.**

The product model is *one account, many gyms, no active gym*. `api.js` states this plainly:

> THERE IS NO AMBIENT ACTIVE GYM ON THE CLIENT. The app presents one unified view — every
> list shows every linked gym at once, and every per-gym call passes `options.gymId`
> explicitly.

That is true **of `api.js` itself** and of nothing else. `users.active_gym_id`,
`db.resolveActiveGymId()`, `POST /api/my-gyms/active` and `gym-context.js`'s single ambient
gym are all still live, and the app still reads them.

---

## Why this keeps producing bugs

The failure is always the same shape, and it is **silent by construction**:

1. A per-gym read or write reaches the server without an explicit gym.
2. `db.resolveActiveGymId(userId)` **guesses** one instead of refusing.
3. The guess is usually right (single-gym accounts, or the gym you happen to be looking at),
   so it survives review and testing.
4. On a two-gym account it writes to, or reads from, **the wrong gym** — with no error, no
   log line, and a plausible-looking result on screen.

Three bugs found on 2026-09-15 were all exactly this:

| Symptom | Actual cause |
|---|---|
| JAB auto-book entry showed the Psycle rail and "Insufficient Credits" | `addAutoBooking` payload omitted `gymId` → server guessed the active gym |
| JAB auto-upgrade never fired; error icon on the spot pill | all 3 `addAutoUpgrade` call sites omitted `gymId` → monitor stored against Psycle, poller then checked Psycle's empty balance and set `paused_no_credits` |
| "No credits available" in the auto-upgrade modal | `eventDetails = event.raw` → no `gymId` on the raw object → credit inventory resolved to the active gym |

None of these threw. All three were found by a person looking at the screen.

---

## What is still active-gym-shaped

### Server — `db.resolveActiveGymId()`, 77 call sites

**Structurally gym-blind.** These take a `userId` and no gym, so they can *only* answer for a
guessed gym unless the caller wraps them in `db.runWithGymContext`:

`updateUserCredentials` · `updateUserJWT` · `updateUserDisplayName` · `cacheUserProfile` ·
`getStudioPreferences` · `getStudioPreference` · **`setStudioPreference`** ·
`getUserSettings` · **`setUserSettings`** · **`replaceBookingCache`** ·
`getBookingCacheForUser` · **`replaceWaitlistCache`** · `getWaitlistCacheForUser` ·
`getUserAutoUpgradesByEvent` · `setUserPriority` · `getUserById` · `getUserByCalendarToken`

The **bold** ones are writes: a wrong guess corrupts data rather than merely displaying the
wrong thing.

**Explicit gym available, but defaults to the guess** (`gymId || resolveActiveGymId(...)`) —
safe only while every caller remembers to pass it, which is precisely what failed three times
today: `addAutoBooking` · `addAutoUpgrade` · `countPendingAutoBookings` ·
`countActiveAutoUpgrades` · `getUserAutoBookings` · `getUserAutoUpgrades` · `getUserSession`

**Correctly gym-blind, leave alone:** `getPendingAutoBookings()`, `getActiveAutoUpgrades()`,
`getAllBookingCache()` (cross-user background scanners — they must NOT filter by gym; they
select `gym_id` and the caller routes per row), and anything keyed on a globally-unique `id`.

### Server — routes that write per-gym data with no explicit gym

- `POST /api/bookings/sync` → `replaceBookingCache` (whole cache replaced against one guessed gym)
- `PUT /api/settings` → `setUserSettings`
- `PUT /api/studio-preferences/:id` → `setStudioPreference`
- `POST /api/config/import` → settings + spot maps + auto-bookings
- `POST /api/notify/booking-success`
- `POST /api/cart/add-bundle/:bundleId`

### Client — the ambient gym is still there

`gym-context.js` opens with *"The active gym's identity, capabilities and theme"* and holds a
single `state = { gymId, name, capabilities, theme, labels }`. `main.js:849` seeds it from the
server's `activeGymId`, falling back to `linked[0]`.

**7 production capability checks read that ambient gym instead of the row's own** (against
exactly 1 correct `canForGym` call), despite AGENTS.md's own rule that a capability question
in a list must be asked per row:

| Site | Risk |
|---|---|
| `bookings.js:582` `can('atomicSwap')` | **Highest.** A per-booking write. `gymId` is in scope four lines above. A JAB booking evaluated against Psycle's `atomicSwap: false` does cancel-then-rebook instead of a native swap — which can lose the spot. The reverse calls a swap endpoint CodexFit does not have. |
| `timetable.js:1250`, `1735`, `2000`, `2194` | Bookmark heart/menu/indicator/toggle, all per-row in a **merged** list. Psycle has `bookmarks: true`, JAB `false` — so JAB rows render a heart whenever Psycle is ambient, and clicking it 501s. |
| `timetable.js:1007`, `1164` | Bookmark filter + list, sourced from `cache.profile` (one gym's profile) in a merged view. |

---

## Recommendation

**Delete the concept rather than keep patching call sites.** Three rounds of "thread `gymId`
through this one" have not stopped the bug class, because the default is still *guess*.

Staged, each stage independently shippable:

1. **Make ambiguity loud (cheapest, highest value — do this first).** When a per-gym read or
   write resolves with no explicit gym **and the account has more than one linked gym**,
   throw instead of guessing. Single-gym accounts are unambiguous, so behaviour is unchanged
   for every existing user; multi-gym accounts turn today's silent corruption into a stack
   trace at the exact call site. This converts the whole remaining backlog from "invisible
   until a user reports it" to "fails in dev the first time it runs".
2. **Fix the 7 client `can()` sites** to `canForGym(flag, row.gymId)` — `bookings.js:582`
   first, it is the one that can lose a spot.
3. **Give the structurally gym-blind accessors an explicit `gymId` parameter** and pass the
   row's own gym at every call site (the mechanical bulk of the work).
4. **Remove `users.active_gym_id`, `POST /api/my-gyms/active`, `getActiveGymId` and
   `gym-context.js`'s singular gym**, replacing the last with per-gym capability lookups.
   Keep a `DEFAULT_GYM_ID` only for genuinely account-less contexts (pre-link signup).
5. **Add a source-scanning regression test** in the style of `test-no-gym-privilege.js`:
   assert no client write helper omits `gymId`, and no per-gym accessor resolves a gym
   without one. This is what stops stage 1–4 from silently regressing.

**Tradeoff:** stage 1 can surface latent wrongness as errors for the two-gym test account —
that is the point, but it means stage 1 and 2 should land together, and stage 3 may need to
follow quickly once stage 1 starts throwing.

**Do not** start stage 3/4 during a feature push: it touches ~30 accessors and every caller.

---

## Progress

### ✅ Stage 1 — ambiguity is now loud (2026-09-15)

`db.resolveGymStrict(userId, explicitGymId, opName)` throws rather than guessing when a
per-gym **write** has no named gym *and* the account is linked to more than one gym. A
single-gym account is unambiguous, so nothing changed for existing users. Applied to
`addAutoBooking`, `addAutoUpgrade`, `countPendingAutoBookings`, `countActiveAutoUpgrades` —
the four that produced the 2026-09-15 bugs. `POST /api/auto-book` and `POST /api/auto-upgrade`
map the error to **400**, since an unnamed gym is a caller bug, not a server fault.

**It immediately earned its keep**, which is the argument for stage 3: turning it on failed
3 suites and 16 assertions that had been silently relying on the guess — including a real
production path (`POST /api/auto-book` accepted a gym-less write on a two-gym account). All
now pass by naming their gym explicitly.

### ✅ Stage 2 — no ambient capability questions (2026-09-15)

All 7 production `can()` call sites now ask `canForGym(flag, row.gymId)`. Verified live on a
two-gym account: **35 hearts across 43 merged rows — every `psycle-london` row has one, every
`jab-boxing` row does not.** Previously, with JAB resolved as the ambient gym, *no* row had a
heart, including Psycle's.

`gateByCapability` now uses `canAny` unconditionally. These gates sit on global chrome above a
merged list, so there is no single gym for them to belong to — the special-case list that
previously routed only `[data-tab="buy-credits"]` to `canAny` meant the "Bookmarked only"
filter vanished whenever the ambient gym lacked bookmarks.

### ✅ Stage 5 — the guard (2026-09-15)

`server/test-no-active-gym.js` (7 checks, in `npm test`) pins both halves: the runtime
refusal-to-guess, and a **source scan** asserting no client module asks an ambient `can(...)`.
The scanner was verified by reintroducing an ambient `can()` and confirming it fails with the
offending `file:line`.

### 🟡 Stage 3 — started with the reminder cache (2026-09-15)

`replaceBookingCache` is done, and it was worse than "guesses a gym". The client syncs the
**merged** list in ONE call, and the old code resolved a single gym and wrote every row under
it. Measured on the live staging account before the fix: **4 cached bookings, all tagged
`psycle-london`, when all four are JAB classes** — so the other gym's rows were never
refreshed either, just left stale. The cancellation scanner reads every row and routes by
`gym_id`, so those reminders were being worked against the wrong gym's session.

Now: each row carries its own `gymId` and is filed under it, and the call takes an explicit
`scopeGymIds` — the gyms it is authoritative for, cleared even when the payload has no rows
for them (how a cancelled last booking actually disappears). The merged route scopes to every
linked gym; `calendar.js`, `poller.js` and `admin.js` scope to the one gym they read from.
Verified live after deploy: the same 4 rows are now tagged `jab-boxing`. Three checks in
`test-no-active-gym.js` pin per-row filing, the cleared-gym case, and the guarantee that a
single-gym caller cannot wipe another gym's cache.

**The reminder sweep is done too.** `poller.js`'s `refreshBookingCaches` read ONE gym per user
*and* did it over a hardcoded CodexFit path (`/bookings?limit=100&page=1`) with
CodexFit-shaped parsing — so a two-gym member got reminders for one gym and silence for the
other, and the gym it did read was only ever right for a CodexFit gym. It now loops the
account's links and goes through each gym's own adapter (`provider.listBookings` with that
gym's session, enriched via the shared per-gym event cache). A gym that fails is excluded from
the write scope, so it keeps its existing rows instead of having them cleared. The dead
CodexFit-only `normalizeBooking` helper went with it (admin.js has its own copy).

Covered by `server/test-reminder-sweep.js`. Two notes on writing it, both worth remembering:
the sweep **prunes past classes at the end**, and the mock fixtures are past-dated, so
asserting on cache contents after a full run passes on an empty table — the first version of
that test did exactly that and proved nothing. And the MarianaTek mock's reservation list
starts empty (it fills on booking), so the JAB check asserts the property that actually
regressed — that the gym is read through the **MarianaTek adapter with that gym's session** —
rather than on rows that would satisfy `every()` vacuously.

### ✅ Stage 3 — spot maps (2026-09-15)

`setStudioPreference` now takes an explicit gym and refuses to guess. **Four of the six client
call sites were omitting it** — the timetable booking modal, `saveAutoBookPreferences`, the
auto-book edit modal and the auto-upgrade config modal, i.e. most spot-map saves. Only
Settings passed a gym, which is why the 2026-09-02 fix (which corrected Settings) looked
complete.

**Found in live staging data, not just in theory:** studio **6282** is JAB's TRAIN room —
`auto_upgrades` row 22 records it under `jab-boxing` — but the member's spot map for it was
stored under **`psycle-london`**. It had been *appearing* to work only because
`pickStudioPrefs` falls back to the bare `studioId` key when the gym-qualified one is missing.
The row was re-filed, and a save through the UI after deploy landed on `jab-boxing` with no
second Psycle row created.

Config export/import went with it: both were single-gym-shaped (export captured one gym,
import restored to a guessed one). Export now fans out across linked gyms and emits a
gym-qualified `studioPreferences` array plus per-entry `gymId` on auto-bookings; import
prefers those and falls back to the legacy object, which only restores unambiguously onto a
single-gym account — exactly what the strict resolver enforces.

### ✅ Stage 3 — settings (2026-09-15, option A)

`setUserSettings` now takes a **patch of only the changed keys and MERGES it**, rather than
replacing both blobs wholesale. Replacing was the root cause: it forced every caller to resend
the entire merged settings object, so a request to change your theme also rewrote the gym half
— with nothing in it saying which gym that half belonged to.

The gym is now required **only when the patch actually touches a gym-scoped key**, which is the
rule that makes this work: `{ theme: 'dark' }` needs no gym at all (demanding one would be as
wrong as guessing), while `{ detectedBookingOffset: 15 }` must name one. Resolution happens
before the transaction, so a refused gym half cannot half-apply the account half.

Call sites, all six now sending only what they change:
- `debugMode`/`prefetchWeeks`, and `notifications` — account-scoped, no gym.
- **`autoBookPaused` moved to account scope**, with an idempotent migration. It was gym-scoped
  by the default rule, but the UI is one Pause button above a MERGED queue: there is no gym to
  name, and the member plainly means "stop auto-booking for me". Conflict rule in the
  migration is paused-anywhere-wins — the recoverable direction for an automated action. Same
  trap as the `calendar` move: the key must be DELETED from the gym rows, because
  `getUserSettings` spreads the gym blob over the account one and a stale copy would override
  the new value forever.
- `detectedBookingOffset`/`bookingWindow` — derived from a profile, which belongs to one gym,
  so `GET /api/profile` now stamps `gymId` on its response and the client saves against it.
- `autoBookFavourites` — these ARE bookmarks, so they save against the bookmarks-capable gym;
  ambiguous (none, or several) returns null and fails loudly rather than writing them to a gym
  with no such concept.

Verified live: changing an account setting saved correctly, preserved the other account keys,
and left the gym blob **untouched** — the old code rewrote it on every save. The
`autoBookPaused` migration was a clean no-op on staging (nobody had it set).

One behaviour change to know about: a save now writes only the halves the patch touches, so an
account with nothing stored for a gym returns `null` from `getUserSettings` instead of an
empty row. That is what `if (!acct && !gym) return null` always meant; it simply used to be
masked by every save creating both rows.

### ✅ Stage 3 — the last writers (2026-09-15)

- **`cacheUserProfile`** now takes an explicit gym and refuses to guess (callers already wrap
  it in try/catch, so a strict throw is safe to let surface). Caught a real instance in
  `poller.js`'s auto-upgrade credit check, which already had `gymId` in scope — it just wasn't
  being passed.
- **`setUserPriority`** — genuinely per-gym-registration (the scheduler joins
  `user_gyms.priority` for a booking's OWN gym, WP-D3), but the admin panel has one "VIP"
  control per user with no per-gym picker. Defaulting to `resolveActiveGymId` silently left
  every OTHER linked gym at the old priority — a user marked VIP kept queuing at default
  priority everywhere except whichever gym happened to be active. Now applies to every linked
  gym when none is named, matching what the single control actually promises; still accepts an
  explicit gym for a future per-gym UI.
- **`updateUserCredentials`/`updateUserJWT`/`updateUserDisplayName`** all fire from a login —
  one specific gym, known to the caller at the point of call. `auth.js`'s real login path had
  already resolved `loginGymId` once and was letting these three re-resolve independently
  rather than reusing it — a second, separate resolution that could in principle land on a
  different gym than the one actually authenticated against. Now threaded through explicitly;
  the dev-mock branch passes `DEFAULT_GYM_ID` (its own login is always Psycle; every other gym
  is seeded separately via the already-explicit `linkGymAccount`).

Six new checks, including the two that caught genuine bugs (`setUserPriority` only updating one
gym; `cacheUserProfile` able to overwrite the wrong gym's cached profile).

### ✅ Stage 4 — the persisted "active gym" is gone (2026-09-15)

`setActiveGym`, `getActiveGymId`, `POST /api/my-gyms/active` and `activeGymId` on
`GET /api/my-gyms` are all removed. The client switcher they served was already deleted (no
production caller remained — confirmed before touching anything), so this was pure dead-code
removal on the client side. Server-side, `resolvePersistedGymId`'s "stored choice" step is
gone; the fallback chain is now: per-request `x-gym-id` context → sole linked gym → default
gym, deterministic every time. `users.active_gym_id` itself is left in the schema (harmless,
unread) rather than run a destructive column-drop migration for a nullable field — same call
already made for `users.encrypted_password`.

**What did NOT get deleted, and why:** `gym-context.js`'s client-side `state`
(`setGymContext`/`can()`/`getGymContext()`) stays. It turned out not to be dead — it is the
last-resort fallback inside `canForGym`/`capabilityForGym` for an unknown gym or a missing
`gymId`, and `credit-allowance.js`'s ambient `isMetered()`/`getTotalCredits()` legitimately
lean on it for single-gym accounts and any code not yet threaded with an explicit gym. Ripping
it out fully — replacing every remaining ambient fallback with something else — is the real
scope of "per-gym capability lookups replacing the singular gym" and was judged too large to
do blind in this pass; flagged below rather than attempted partially.

**Found and fixed while doing this:**
- `timetable.js`'s booking modal read `maxSpotsPerClass` (JAB: 1, Psycle: unlimited) from the
  **ambient** gym via `getGymContext()` instead of the class actually being booked — the exact
  same bug shape as everything else in this audit, just one level deeper (inside a fallback
  path, not a top-level call site). Fixed via a new `capabilityForGym()` (like `canForGym` but
  returns the raw value, since `maxSpotsPerClass` is numeric — `canForGym`'s `!!` coercion
  would turn `1` into `true` and `null` into `false`, both wrong). This was
  `getGymContext()`'s only production caller with real effect; removing it made the function's
  historical "singular active gym" purpose genuinely dead — until `settings.js`'s
  `renderGymSettingsSection` picked up a second, legitimate use (below).
- `settings.js`'s per-gym save handler compared `gymId === myGyms.activeGymId` to decide
  whether to mirror a save into the in-memory `userSettings` blob — with `activeGymId` gone,
  that comparison would have silently become permanently false, so an edit to what LOOKS like
  the default gym's settings would stop updating the in-memory copy the rest of the app reads.
  Fixed to compare against `getGymContext()?.gymId`, the client's own notion of the default
  gym (same source `loadGymContext()` derives from `linked[0]`). Verified live: toggled JAB's
  Auto-Upgrade Polling off and on, confirmed both writes landed server-side.
- `test-gym-isolation.js`'s `on(uid, gym)` helper — used at 21 call sites — was built entirely
  on `setActiveGym`. Rewritten to wrap assertions in `db.runWithGymContext(uid, gym, fn)`
  instead, which is the SAME mechanism a real `x-gym-id` header uses in production — a fidelity
  improvement over testing a persisted-choice mechanism that no longer resembles how the app
  actually resolves a gym.
- `test-active-gym.js`'s rollout-gate test asserted `setActiveGym` refused a disabled gym —
  the only place that gate was tested. Rewritten against `linkGymAccount`'s own `enabled`
  check, which is now the ONLY place the WP-T4 rollout gate is enforced (link time, not
  selection time — there is no more "selection").

Verified live: reloaded a cold two-gym timetable (149 rows), opened JAB's gym settings section,
toggled a real setting and confirmed the write in the database both ways.

### ✅ Read-side accessors (2026-09-16)

Audited every remaining `resolveActiveGymId(userId)` call in `db.js` by tracing its actual
production callers rather than fixing mechanically. Two things fell out of that:

**Most reads turned out to already be safe**, not because anyone threaded a gym through them,
but because `authenticateToken` always chains `withGymContext` — so any HTTP route reached with
an `x-gym-id` header already resolves correctly via request-scoped context, and `calendar.js`'s
per-gym loop wraps its reads the same way. The remaining ambient reads that only ever touch
account-scoped keys (`notifications`, `calendar.enabled`, `debugMode`) are correct by
construction — the key doesn't vary by gym, so there was nothing to fix.

**Five were real bugs, all in the two execution engines that actually book and upgrade
classes:**
- `scheduler.js`'s `resolvePendingReleases()` and `checkAndRunImmediateBookings()` — the
  wake-clock engine — read `getUserSettings(booking.user_id)` with no gym, when
  `getClassReleaseTime` uses it to read `detectedBookingOffset` (Psycle's rolling-weekly
  member-tier offset). This "worked" only by accident: Psycle is `DEFAULT_GYM_ID`, which the
  ambient fallback prefers on a multi-gym account with no context — fragile, not correct, and
  would silently break the moment a different gym became default or a new rolling-weekly gym
  was added that wasn't the default. Fixed to read each booking row's own `gym_id`.
- Same function, the auto-upgrade registration after a successful auto-book read
  `autoUpgradeEnabled`/`autoUpgradeByDefault` ambiently instead of from the booking's own
  `gymId`, which was sitting unused two lines above the call.
- `poller.js`'s `executeAutoUpgradeChecks()` read `autoUpgradeEnabled` ambiently from
  `upgrade.user_id` instead of `upgrade.gym_id` — could pause or fail to pause a monitor based
  on an unrelated gym's setting.
- **The sharpest ones**: `scheduler.js`'s `resolveLiveMap()` and `poller.js`'s upgrade slot
  check both called `getStudioPreference(userId, studioId)` with no gym — while a comment
  sitting *two lines above the call*, in both files, explained exactly why that's wrong ("from
  the ROW, not the active gym... a JAB upgrade must run while the user is looking at Psycle").
  The rule was written down correctly and the code next to it didn't follow it. Verified live
  against your real JAB monitor (studio 6282): the poller's next cycle still correctly detected
  a better slot via its own spot map — the fixed read path works end to end. (The atomic swap
  itself then failed on a pre-existing, unrelated JAB session auth issue.)

`getStudioPreference(s)` and `getUserSettings` now take an optional `gymId`, tried first before
falling back to the deterministic default. Two new guard checks pin both fixes with colliding
studio ids / booking offsets across gyms, mirroring the write-side tests.

Left alone, logged as a display-only limitation rather than fixed: `getUserDetail` (admin
panel) shows one gym's profile/settings/session arbitrarily (whichever resolves as default) but
correctly shows every gym's queue entries — a real gap, but a UI one (needs a gym picker), not
a booking-correctness bug.

### Still open

The larger, deliberately-not-attempted piece — see
[the backlog entry for it](../BACKLOG.md#clients-ambient-gym-context-fallback-still-exists-deferred-from-stage-4-2026-09-15):
fully removing `gym-context.js`'s ambient client state by giving every remaining `canForGym`/
`capabilityForGym`/credit-allowance call site a real explicit gym instead of a permissive
fallback.

One more single-gym read spotted in passing, not yet fixed: `poller.js`'s weekly
booking-window tip still does `fetchFromGym(userId, db.resolveActiveGymId(userId), '/profile')`
— one gym, over a raw CodexFit path.
