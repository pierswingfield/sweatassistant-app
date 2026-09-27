# C4 — Live acceptance, promote `modular` to prod, JAB launch

**Priority:** P0 milestone · **Size:** ~3 days of hands-on work, ~1–2 weeks elapsed (some checks
wait for real release windows and penalty windows)
**Depends on:** C1, C2 phase 1, C3, C7 pre-launch subset · **Blocks:** C2 phase 2, U3, most of F

> **Verify first:** before changing anything for an item, confirm its basis in the code **and**, for anything user-visible, **in a real browser** (CDP :9222 or Claude for Chrome). For server-only items, use a failing test or a request. Record the evidence. If a browser check is needed and no browser is available, stop with `BLOCKED`. See [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md).

Prod runs the old single-gym `master`. The dev twin runs `modular`. The mechanical suites are
green, and most of the live matrix passed on 2026-09-15 and 09-23. This workstream closes the
remaining live checks, ships `modular` to prod, and then turns JAB on.

Rules for live testing: [`LIVE_VERIFICATION_PLAYBOOK.md`](../LIVE_VERIFICATION_PLAYBOOK.md).
Flow matrix: [`QA/USER_FLOW_VALIDATION_PLAN.md`](../QA/USER_FLOW_VALIDATION_PLAN.md).
Prior results: [`QA/browser-runs/`](../QA/browser-runs/).

## Stage A — Remaining live verification (dev twin)

| # | Check | Why it's still open | Est. |
|---|---|---|---|
| C4-1 | **Unattended future Auto-Book fires at a real release** (Psycle Monday release and a JAB rolling window) | Only verified while someone was watching | wait for a release |
| C4-2 | MarianaTek **cancel inside the penalty window**: confirm the penalty warning and the actual outcome | Never exercised live [Q9] | 1 h + a booking |
| C4-3 | MarianaTek **auto-upgrade cutoff** matches the real penalty boundary | Cutoff is assumed, not measured [Q9] | 1 h |
| C4-4 | MarianaTek **native waitlist auto-fill** doesn't fight the app's own waitlist handling | Unknown interaction [Q7] | needs a full class |
| C4-5 | **Colliding provider IDs** across gyms (same event or location ID at Psycle and JAB) | Mock-tested only | 1 h |
| C4-6 | **Fresh account onboarding** end to end, including linking a second gym | Done piecemeal, never on a clean account | 1 h |
| C4-7 | **Installed PWA** on iOS: layout, offline, and push delivery for both gyms | Browser only so far | 1 h |
| C4-8 | **Calendar feed on a real phone**: one `.ics` spanning both gyms | Desktop only | 30 min |
| C4-9 | **Credits & Membership** tab live acceptance for both gyms (after C2-1) | Built 2026-09-12, never accepted live | 1 h |
| C4-10 | **Psycle regression** after C2 phase 1: `test-regression-psycle.js` plus a live book, cancel and waitlist cycle | New cart and waitlist code | 1 h |

## Stage A results — 2026-09-27

Dev twin `sweat-dev.wingfield.tech`, HEAD `c508442`, real Chrome via CDP `127.0.0.1:9222`, account
`test@piersj.com` (Psycle + JAB linked). Inventory taken before and after: Psycle 0 bookings / 0
waitlists / 2 credits / 0 auto-book entries, JAB 1 booking / 1 waitlist (both pre-existing,
untouched) / 0 auto-book entries — identical at start and end. Screenshots and raw API captures are
in the session scratchpad (not committed — contain live account/customer PII from CodexFit's
`relations` payloads). Only rows C4-1/5/6/9/10 were in scope for this pass.

- [x] **C4-10 — PASS** (waitlist cycle), **book/cancel SKIPPED**.
  - `node server/test-regression-psycle.js` (Node 20, `ENCRYPTION_KEY` generated ad hoc): **25/25
    checks passed.**
  - Live waitlist join → leave on event 216705 ("BARRE: Abs & Arms 45", Oxford Circus, Tue 29 Sep
    07:30 BST, full, ~53h out at test time): `GET /api/waitlists` 0 → clicked **Join Waitlist**
    (`POST /api/waitlist/join` 200) → 1 entry (`bookingId 300491`, `eventId 216705`) → clicked
    **Leave WL** + confirm (`POST /api/waitlist/leave` 200) → back to 0. **Proves C2-2 live**:
    `codexfit.js leaveWaitlist()` resolves the caller's own waitlist row id via `listWaitlists()`
    before `DELETE /waitlists/{rowId}`, not `{eventId}`.
  - Book/cancel skipped: found a live-confirmed bug (see C4-9 below) that makes the app report 0
    usable Psycle credits / `canBook: false` for an account that has 2. With only 2 real credits
    at stake and genuine doubt about reasoning safely about credit state through the exact code
    path just found unreliable, skipped per the task's own "if any doubt, skip" instruction.
    `POST /api/book`/`/api/cancel` remain mock- and shape-verified only, not live-exercised this
    session.

- [x] **C4-9 — FAIL (Psycle side); PASS (JAB side).**
  - JAB: tab showed "Member — SW1 Rolling Membership — Reserve 14 days in advance — 2 guest passes
    left". Matches `GET /api/membership` (`isActive:true`, `guestPassesRemaining:2`) and
    `GET /api/eligibility` (`canBook:true`). **Note**: this is a live-state change from the prior
    session's finding that this account showed "No membership" — recorded, not acted on; no JAB
    booking was authorized for this session regardless of eligibility.
  - Psycle: tab showed **"0 credits available — you cannot book here until you top up"** and every
    open timetable row showed "Buy Credits" instead of "Quick Book". Does not match the provider:
    `GET /api/profile` shows `raw.data.available_credits=[{count:2,...}]` and
    `stats.credits_remaining:2`; `GET /api/credits` returns `{"credits":[]}`; `GET /api/eligibility`
    returns `{"canBook":false,"reason":"No credits available"}`.
    - **Root cause**: `server/providers/codexfit.js` `getProfile()` (~L225), `getEligibility()`
      (~L250) and `getCredits()` (~L274) all call `this.request('/profile', ...)` and read fields
      straight off the JSON body (`u.available_credits`, `u.id`, `u.booking_cutoff`). The real
      `GET /api/v1/customer/profile` returns `{ data: { available_credits, id, booking_cutoff, ... } }`
      — confirmed in `server/fixtures/codexfit-v2/PARITY.md` (2026-09-26) and reconfirmed live this
      session — and none of the three methods unwrap `.data`, so every field read is `undefined`.
      Invisible to `test-regression-psycle.js` because `server/mock.js`'s dev `/profile` fixture
      isn't wrapped in `{data:...}`. Not fixed here (out of scope); flagged as a follow-up task.
  - Buy Credits → bundle view (Psycle): opened, "EXPERIMENTAL" banner, bundles listed (e.g. "2
    Credit Offer" £25.00). Stopped there, no Buy click, no checkout.

- [x] **C4-5 — PASS, no live collision.** Live `GET /api/timetable` both gyms (2,695 Psycle events,
  1,000 JAB events): event ids Psycle `216463–219386` vs JAB `57598–60976`; location ids Psycle
  `{1,4,8,10,15,17,19}` vs JAB `{48751}`; studio ids Psycle `{71..170}` (26 values) vs JAB
  `{6282,6283,6286,6287,6289,6290}` — **no overlap in any of the three id spaces**. The
  cross-gym-collision isolation guarantees (`test-gym-isolation.js` §8, gym-qualified cache keys)
  remain mock-tested only for the actual-collision case; these two live tenants' id ranges simply
  don't intersect.

- [x] **C4-6 — PASS.** Signed up `c4-onboarding-20260927@piersj.com` (`needsGym:true`); existing
  session saved/restored around it. Settings → Your Gyms rendered "No gyms linked. Add one to start
  booking." + "+ Connect a gym" cleanly; the modal (gym select, email, password, "Link gym") opened
  cleanly — stopped there, no credentials. Deleted via `DELETE /api/auth/me` → `{"success":true}`;
  confirmed gone (`GET /api/my-gyms` → `{"gyms":[]}`, `GET /api/settings` → `{}` on the same JWT).
  Side note, not a bug: `GET /api/auth/status` still 200s post-delete (pure JWT decode, no DB
  existence check — stateless by design, no revocation mechanism documented).
  Separately (not a new finding, but sharpest here): the no-gym **Timetable** panel shows "Connect
  to the internet to load the timetable / Retry" — misleading for a 409 `NO_GYM_LINKED` state,
  confirmed via network trace. Settings → Your Gyms is the accurate no-gym surface; Timetable's
  copy is the least accurate one.

- [x] **C4-1 — reported, not queued.** `GET /api/auto-book` empty for both gyms. **No entry exists
  for the next Psycle release** (Monday 2026-09-28 12:00 London). Nothing queued this session — the
  user decides.

**Not attempted this pass (need something only the user can provide):**
- **C4-2**: a real JAB booking currently inside its penalty window, plus explicit go-ahead to
  cancel it knowing the credit/allowance may not be restored.
- **C4-3**: a real JAB class with an active auto-upgrade monitor approaching its cutoff, observed
  live as it happens.
- **C4-4**: a full JAB class with a spot opening up mid-observation — can't be manufactured safely;
  opportunistic only.
- **C4-7**: the user's iPhone, PWA installed to the home screen.
- **C4-8**: the user's phone's calendar app, subscribing to the `.ics` feed URL.

## Stage B — Promote to prod

| # | Step |
|---|---|
| C4-11 | Back up the prod DB **with WAL** (or run C1-5's job). Record a rollback path: the previous image tag, with the Pi standby container kept. |
| C4-12 | Dry-run the modular migrations against a **copy** of the prod DB (`user_gyms` backfill, calendar-to-account-scope, gym-scoped tables). Check row counts before and after. |
| C4-13 | Deploy `modular` to `psycle-app` with **JAB disabled** (`JAB_BOXING_ENABLED` unset). Prod users should see no functional change apart from the new UI. Clear all three client caches when verifying (SW, IndexedDB, hard reload). |
| C4-14 | Soak for a few days, covering at least one Psycle Monday release with real auto-books. |

## Stage C — Enable JAB

| # | Step |
|---|---|
| C4-15 | Set `JAB_BOXING_ENABLED=true` in prod, or make `enabled: true` the config default. `gyms.config.js` ~L125 is still env-gated. |
| C4-16 | Update `AGENTS.md` status, the service registry, and this folder. [WP-T4, WP-X1] |

## Done when

- [ ] All Stage A rows pass or are consciously waived (write the reason here).
- [ ] Prod runs `modular`; one Psycle release cycle passed with no regressions.
- [ ] JAB enabled in prod, with at least one real JAB booking made through prod.
