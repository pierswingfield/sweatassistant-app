# Testing

```bash
npm test              # everything: 60 server suites + the client suite
npm run test:server   # server only
npm run test:client   # client only (vitest)
```

Server suites need Node 20 and an `ENCRYPTION_KEY`; `server/run-tests.js` generates a throwaway
one and forces `DB_PATH=':memory:'`, so `npm test` works from a clean checkout.

---

## The three layers, and what each can actually catch

Each layer exists because the one above it demonstrably missed a real bug in this codebase.

| Layer | Command | Catches | Cannot catch |
|---|---|---|---|
| Server suites | `npm run test:server` | Adapter contracts, gym isolation, booking-window equivalence, relogin ladders | Anything in the browser |
| Client units | `npm run test:client` | Pure logic in `lib.js` — release resolution, offsets, formatting | Anything needing the DOM or a live API |
| Browser smoke | manual, via Claude for Chrome | Wiring: does the real app render real data | Not automated; run it before a deploy |

### Server suites — `server/test-*.js`

Standalone scripts, one process each, discovered by filename. A new `server/test-*.js` is picked
up with no registration step, so a suite cannot be silently dropped from the run. They are
separate processes on purpose: each boots `db.js` against its own in-memory database, and a
shared runner would have them fighting over one schema.

Three are worth knowing about specifically:

- **`test-gym-isolation.js`** — the only multi-gym suite, so the only place a missing
  `AND gym_id = ?` shows up as red. Every other suite is single-gym and passes regardless. Its
  **section 8** covers in-memory state (the scheduler's claim sets, the shared event cache),
  because `gym_id` on every table made the *database* safe while process-local Maps keyed on
  provider ids stayed collidable — and no SQL predicate can catch that.
- **`test-wake-clock.js`** — asserts **which instant the scheduler arms** for a given queue, and
  which bookings dispatch at it. That assertion did not exist until 2026-09-02, and its absence
  is exactly how a hardcoded Psycle Monday noon survived the booking-window work: every other
  dispatch test enters through `runAllPendingBookings()` / `checkAndRunImmediateBookings()`, which
  take the queue as given and so never question the clock above them. A per-class gym's auto-book
  was 50 hours off and would never have fired. **If you touch `scheduleReleaseWindow()`, this is
  the suite that matters** — plus `test-regression-psycle.js`, which boots the real server.
  *Fixture note:* a Psycle class only ~10 days out has already released, so it will not arm
  anything; use ~30 days out to get a future release Monday.
- **`test-no-gym-privilege.js`** — encodes the phase's acceptance criterion by scanning source:
  no module-level `getProvider(...)`, no `getProvider('literal')`, no hardcoded provider
  hostname, no identifier named after one platform. Source-scanning is normally a smell, but the
  thing being prevented *is* a source-level property, and it is one reviewers miss.

### Client units — `client/src/*.test.js` (vitest)

Added after a real bug shipped through a green build: `getClassReleaseTime(q || startAt, ...)`
referenced a `q` that wasn't in scope — a `ReferenceError` on every countdown tick, and
`vite build` reported success.

These cover the rules where **being wrong is invisible**: the app renders, the countdown ticks,
and it counts to the wrong instant. A build cannot catch that and a human won't notice until a
Monday.

- **`cache.test.js`** — that a cache key changes with the active gym *without anyone clearing
  anything*. The old design was correct only while every path that switches gym remembered to
  call `applyGymSwitch()`, which is a guarantee resting on a habit.
- **`credit-allowance.test.js`** — that an unmetered (membership) gym reports `Infinity`, not
  `0`. Returning 0 makes every downstream `total < needed` check render "cannot book" at a gym
  where there is simply nothing to charge.

### Browser smoke test — Claude for Chrome

> Drive the user's real Google Chrome: CDP on `127.0.0.1:9222`, or the Claude for Chrome extension.
> If neither is available, stop with `BLOCKED`; don't substitute a headless or fresh browser. Backlog work
> also needs a browser check **before** the change. See [Workstreams/AGENT_PROTOCOL.md](Workstreams/AGENT_PROTOCOL.md).

```bash
npm run dev     # server :3000, client :5173
```

Then, in the browser: log in as `dev@psycle.com` (any password) to get the mock gym data, and
walk the five tabs checking each renders and the console is clean.

**This layer is not optional, and it is not redundant.** It has caught things the other two
could not, in the same session that added it:

- The location filter rendered **zero options** after the metadata migration. `locationIds` held
  normalized strings while the filter compared `Number(l.id)` — silently false, no error, empty
  dropdown. The build passed and all 30 automated tests passed.
- Confirmed `releaseAt` end-to-end: a Tuesday class stamped `2026-08-17T12:00+01:00`, a Monday
  exactly 15 days earlier, stored on the queue row and read back by the scheduler.
- **2026-09-02, three more, all invisible to 16 server suites and 35 client tests.** (1) A JAB
  user was served **Psycle's timetable** — `timetable.js` caches raw events in a *different*
  IndexedDB store than the one that had been gym-keyed, so every network call was right and the
  screen was wrong. (2) **"⚠ Insufficient Credits" on every JAB card** — four call sites did their
  own credit `reduce()` and skipped the `isMetered()` guard. (3) The About pane told a JAB user
  the app was "an unofficial companion for **Psycle London**" using "**CodexFit** credentials",
  with auto-book firing "(Monday 12PM)". **Nothing threw; the console was clean in all three.**
  That is the signature of what this layer is for: wrong data and wrong words render just as
  happily as right ones.

---

## Writing a test that can actually fail

**Mutation-test anything load-bearing.** A green suite proves nothing until you have watched it
go red. Break the behaviour deliberately, confirm the failure, restore:

```bash
# e.g. re-introduce a gym-scoping bug and confirm test-gym-isolation catches it
sed -i '' 's/WHERE user_id = ? AND gym_id = ?/WHERE user_id = ?/' server/db.js
node server/test-gym-isolation.js    # must FAIL
git checkout server/db.js
```

Every suite added during the multi-gym work was mutation-tested this way. Two of them were blind
on the first attempt and had to be tightened.

**Assert against the declared contract, not against fixture data.** A parity check comparing two
adapters' emitted fields failed because one mock lacked addresses — measuring the fixtures, not
the contract. Compare against the shape the normalizer declares.

**Date-dependent assertions need fixed dates.** One check asserted a computed release was "nowhere
near now" and broke because the run happened to be on that date. Use a far-future date so today
can't confound it.
