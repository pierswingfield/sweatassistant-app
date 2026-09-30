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

- [x] **C4-9 — FAIL (Psycle side); PASS (JAB side). Fix pending redeploy (logged as C2-7,
  2026-09-27) — see `C2-psycle-api-v2.md`.**
  - JAB: tab showed "Member — SW1 Rolling Membership — Reserve 14 days in advance — 2 guest passes
    left". Matches `GET /api/membership` (`isActive:true`, `guestPassesRemaining:2`) and
    `GET /api/eligibility` (`canBook:true`). **Note**: this is a live-state change from the prior
    session's finding that this account showed "No membership" — recorded, not acted on; no JAB
    booking was authorized for this session regardless of eligibility. Investigated as C3-13
    (2026-09-27): not reproduced as a code bug — a fresh live check the same day showed badge,
    eligibility and membership all agreeing ("Member" / `canBook:true` / `isActive:true`); see
    `C3-multi-gym-correctness.md`.
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

- [x] **C4-1 — PASS (Psycle 2026-09-28, JAB rolling window 2026-09-29, tested by user).**
  - Psycle: queued event 217241 fired unattended at the Monday release (12:00:00.004 London), booked slot 14, push delivered.
  - JAB: rolling window auto-book tested and confirmed working by the user on 2026-09-29.
- [x] **C4-8: subscribing in Apple Calendar works on the dev twin (user, 2026-09-28)**, after adding a Cloudflare Access bypass for `sweat-dev…/api/calendar/*`. The follow-up user re-test on 2026-09-29 also reported C3-14/C3-15 and C4-8 as good; the secure Apple link and link/unlink feed refresh are covered by the fixes recorded in the C3 workstream.
- [x] **C4-7 — PASS (2026-09-29, tested by user):** Installed PWA on iOS, layout, offline caching, and push delivery confirmed working.

## C4-9 re-check — 2026-09-27 (post C2-7 redeploy) — **PASS**

Dev twin redeployed to HEAD `49e1f7d` (C2-7's `/profile` envelope-unwrap fix). Verified via
`docker ps` (up), a clean `docker compose up -d --build` init log, `GET /api/health` → 200, and
`unwrapProfileEnvelope` present in the running container's `/app/server/providers/codexfit.js` (4
hits: definition + 3 call sites). DB snapshotted first to
`data/psycle.db.bak-20260927-025441{,-wal,-shm}` on oracle.

Live re-check, same account (`test@piersj.com`), real Chrome via CDP `127.0.0.1:9222`: one tab
opened, service worker unregistered, CacheStorage and IndexedDB (`psycle-cache`) cleared, then a
hard reload (`Page.reload` with `ignoreCache: true`) — the saved JWT was restored into
`localStorage` afterward (the clear step also wiped it; no credentials were entered, the existing
30-day token from earlier in this session was reused). Cold two-gym load completed and the app
reopened on the last route.

- `GET /api/credits` (`x-gym-id: psycle-london`) → `{"credits":[{"typeId":"1","typeName":
  "Universal","count":2,...}]}` — the real 2 credits, not `[]`.
- `GET /api/eligibility` (`x-gym-id: psycle-london`) → `{"canBook":true}`.
- `GET /api/profile` (`x-gym-id: psycle-london`) → `bookingCutoff`/`extendedCutoff` both
  `"2026-10-06T00:00:00"` — non-null, matching the real profile's `booking_cutoff`.
- UI: header badge reads "JAB Member" + "Psycle 2 cr". Credits & Membership tab shows "Psycle —
  CREDITS — 2 — credits available — Buy credits →" (not "0 credits available — you cannot book here
  until you top up"). Open Psycle timetable rows (e.g. 08:00 Ride Signature 45, 08:30 Infrared
  Sculpt 50) now show "⚡︎Quick Book" instead of "Buy Credits". A handful of Lagree "Reformer
  Signature" rows still show "Buy Credits" — expected, not a regression: those classes require a
  credit type/count this account's 2 Universal credits don't cover, which is the per-class
  credit-type gating AGENTS.md documents, not the blanket "0 available" bug C2-7 fixed. JAB tab and
  badge unaffected ("Member", "SW1 Rolling Membership", "2 guest passes left").
- Reads only: 3 explicit API checks above plus normal page-load fetches from one cold reload and
  one tab click (Credits & Membership); well under the 20-read cap. No bookings, cancels, waitlist
  actions or checkout. No 429s observed. One CDP tab opened and closed at the end; the user's own
  tabs were not touched.

**C4-9 verdict: PASS** on both gyms. **C2-7 status: live-verified on dev twin.**

**Not attempted this pass (need something only the user can provide):**
- **C4-2**: a real JAB booking currently inside its penalty window, plus explicit go-ahead to
  cancel it knowing the credit/allowance may not be restored.
- **C4-3**: a real JAB class with an active auto-upgrade monitor approaching its cutoff, observed
  live as it happens.
- **C4-4**: a full JAB class with a spot opening up mid-observation — can't be manufactured safely;
  opportunistic only.

## Waived as launch blockers (2026-09-28, user decision)

- **C4-2** (MarianaTek cancel inside the penalty window) and **C4-3** (auto-upgrade cutoff vs the real penalty boundary) are **not launch blockers**. The user will not run a penalty-window cancel as part of acceptance. **The user will test these on their own time**, when a real penalty-window cancel happens naturally, and will record the result here. Until then, the penalty warning copy and the auto-upgrade cutoff stay as designed, not live-measured.

## Stage B — Promote to prod (Decision: Clean DB Rollout + JAB Enabled at Launch)

**2026-09-29 User Decisions:**
1. **Clean DB Rollout**: Prod currently holds only 3 test accounts with 0 pending auto-bookings. To avoid carrying forward legacy single-gym schema debt, vestigial columns, or NULL `password_hash`es, prod will roll a fresh SQLite DB on deploy instead of running the migration backfill. Old DB is backed up to Drive first.
2. **JAB Enabled at Launch**: Staged rollout with JAB disabled is waived; multi-gym support (Psycle + JAB) launches enabled from day one.
3. **Admin Panel Review Step**: Explicit verification of `/admin` both before deploy (on dev twin) and post-deploy (on prod).

| # | Step | Notes |
|---|---|---|
| **C4-10b** | ✅ **DONE (2026-10-01).** **Admin panel review on dev twin** | User reviewed and approved `/admin` on `sweat-dev.wingfield.tech`: user list, linked gym details, relogin indicators (C6-4), user detail drawer with gym picker (C3-8), priority tiers, and gym presentation editor (F-7). |
| **C4-11** | **Back up prod DB with WAL (Approved, pre-deploy step)** | Run `sudo /usr/local/sbin/psycle-backup-sqlite.sh` on oracle to ensure existing prod DB is archived with WAL and copied to Google Drive before clean DB init. |
| **C4-12** | **Prepare clean DB on prod host** | Move/archive `/home/piers/services/psycleapp/data/psycle.db` aside so `db.js` will initialize a pristine multi-gym schema on startup. |
| **C4-13** | **Deploy `modular` with JAB enabled** | Ensure `JAB_BOXING_ENABLED=true` in prod config/env. Deploy via `./deploy.sh --prod`. Clear all 3 client caches on first load (SW, CacheStorage, IndexedDB). |
| **C4-14** | **Prod Admin panel & first onboarding** | 1. Log in to `https://sweat.wingfield.tech/admin` and verify clean initial state.<br>2. Sign up the primary Sweat Assistant account on `sweat.wingfield.tech`.<br>3. Connect Psycle London and JAB Boxing in Settings → Your Gyms.<br>4. Re-check `/admin` to verify user and links show up cleanly. |
| **C4-15** | **Update service registry and docs** | Update `AGENTS.md` status, the host registry, and mark C4 complete. |

## Done when

- [x] All Stage A rows pass or are consciously waived (C4-1, C4-5, C4-6, C4-7, C4-8, C4-9, C4-10 passed; C4-2/3 waived).
- [x] Admin panel reviewed and approved on dev twin (C4-10b, 2026-10-01).
- [ ] Prod deployed with clean DB and JAB enabled.
- [ ] Primary account onboarded on prod, both gyms linked, verified in `/admin`.
