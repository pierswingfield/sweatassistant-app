// Sweat Assistant — Psycle (CodexFit) black-box regression harness. [WP-T3]
//
// This is the safety net for the modular multi-gym refactor (see
// Documentation/Backlog/modular-gyms/PLAN.md §5). It boots the REAL Express
// server as a child process, drives it over HTTP exactly like the PWA client
// does, and asserts on response shapes — so behavior changes introduced while
// migrating server.js / scheduler.js / poller.js / calendar.js onto the
// provider adapter (WP-A4) are caught immediately.
//
// Uses the dev@psycle.com mock path (server/mock.js) so it runs with no live
// CodexFit credentials and no network access. Run before/after each adapter
// migration step; must stay green through the end of Phase 1.
//
// Usage: node server/test-regression-psycle.js

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-regression.db');

// mock.js persists dev-mode bookings to this file at a FIXED path (not
// configurable) — it's a real, git-tracked fixture shared with local dev
// (`npm run dev`), not test scratch space. The harness must not delete it;
// back it up and restore it so a test run never mutates the checked-in file.
const MOCK_BOOKINGS_PATH = path.join(__dirname, 'mock_bookings.dbjson');
const MOCK_BOOKINGS_BACKUP = `${MOCK_BOOKINGS_PATH}.regression-backup`;
const hadMockBookings = fs.existsSync(MOCK_BOOKINGS_PATH);
if (hadMockBookings) fs.copyFileSync(MOCK_BOOKINGS_PATH, MOCK_BOOKINGS_BACKUP);

for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

let child;
let failed = false;

function log(msg) { console.log(msg); }

async function waitForServer(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/config`);
      if (res.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server did not become ready in time.');
}

async function poll(fn, { timeoutMs = 6000, intervalMs = 200 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('poll() timed out waiting for condition.');
}

async function run() {
  child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH,
      NODE_ENV: 'development', // dev mode: rate limiters skipped, dev@psycle.com mock active
      JWT_SECRET: 'test-regression-jwt-secret',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      APP_NAME: 'Sweat Assistant',
      ADMIN_PASSWORD: 'test-admin-password', // enables /api/admin/* (503 without it)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {}); // silence normal server logs; uncomment to debug:
  // child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));

  await waitForServer();
  log('✅ Server booted (dev mode, mock CodexFit backend).');

  let token;
  let autoBookId;
  let studioIdForPrefs;

  // --- 1. Config -------------------------------------------------------------
  {
    const res = await fetch(`${BASE}/api/config`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.appName, 'Sweat Assistant');
    log('✅ GET /api/config returns configured appName.');
  }

  // --- 2. Login (dev@psycle.com → mock) --------------------------------------
  {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dev@psycle.com', password: 'anything' }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, `login failed: ${JSON.stringify(data)}`);
    assert.ok(data.token, 'login response should include a token');
    assert.strictEqual(data.user.email, 'dev@psycle.com');
    token = data.token;
    log('✅ POST /api/auth/login (dev mock) issues a local JWT.');
  }

  const authed = (extra = {}) => ({ ...extra, headers: { authorization: `Bearer ${token}`, ...(extra.headers || {}) } });

  // --- 2b. Signup + recovery over real HTTP (Decision D4) ---------------------
  {
    const post = (path, body) => fetch(`${BASE}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    // A Sweat Assistant account can be created with no gym at all.
    const email = `sa-signup-${Date.now()}@test.local`;
    const signup = await post('/api/auth/signup', { email, password: 'a-real-password' });
    const signupData = await signup.json();
    assert.strictEqual(signup.status, 200, `signup failed: ${JSON.stringify(signupData)}`);
    assert.ok(signupData.token, 'signup issues a session immediately');
    assert.strictEqual(signupData.needsGym, true, 'and flags that a gym still needs linking');

    // That account can reach the app, and gym-scoped routes tell it exactly why
    // they cannot serve — a distinct code, not a generic 401 login loop.
    const saAuthed = { headers: { authorization: `Bearer ${signupData.token}` } };
    const mine = await (await fetch(`${BASE}/api/my-gyms`, saAuthed)).json();
    assert.deepStrictEqual(mine.gyms, [], 'no gyms linked');
    const tt = await fetch(`${BASE}/api/timetable`, saAuthed);
    const ttBody = await tt.json();
    assert.strictEqual(tt.status, 409, 'a gym-scoped route returns 409, not 401');
    assert.strictEqual(ttBody.code, 'NO_GYM_LINKED', 'with a code the client can branch on');

    // Duplicate signup is refused.
    assert.strictEqual((await post('/api/auth/signup', { email, password: 'another-one' })).status, 400);

    // Recovery endpoints were removed with the gym-login mechanism — assert they
    // are actually gone rather than silently reachable.
    for (const path of ['/api/auth/recover/options', '/api/auth/recover/complete']) {
      const gone = await post(path, { email });
      assert.strictEqual(gone.status, 404, `${path} must be removed, not left reachable`);
    }

    log('✅ Signup creates a gym-less account (409 NO_GYM_LINKED on gym routes); recovery endpoints removed.');
  }

  // --- 3. Auth status ----------------------------------------------------------
  {
    const res = await fetch(`${BASE}/api/auth/status`, authed());
    assert.strictEqual(res.status, 200);
    log('✅ GET /api/auth/status validates the local JWT.');
  }

  // --- 4. Normalized timetable (relations resolved) ---------------------------
  {
    const res = await fetch(`${BASE}/api/timetable`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    const events = data.events || [];
    assert.ok(Array.isArray(events) && events.length > 0, '/api/timetable should return classes');

    // This used to assert the RAW `{ data, relations }` envelope through
    // /api/proxy/events. That route is gone (WP-D9), but the property it was
    // really protecting is stronger when asserted here: CodexFit returns list
    // events BY REFERENCE (event_type_id / studio_id / instructor_id, entities
    // in a sibling `relations` bag), so an adapter that forgets
    // resolveEventRelations() yields normalized events with no discipline,
    // studio, location or instructor — which is exactly how the "every class
    // renders as a generic CLASS pill" regression looked. Asserting the
    // normalized OUTPUT catches that whether or not the envelope ever changes.
    const ev = events[0];
    assert.ok(ev.id && ev.startAt, 'normalized events carry id and startAt');
    assert.ok(ev.discipline, 'discipline resolved from the relations bag, not left blank');
    assert.ok(ev.studioId != null && ev.studioName, 'studio resolved from the relations bag');
    assert.ok(ev.locationName, 'location resolved via the studio, from the same bag');
    assert.ok(ev.instructors && ev.instructors[0] && ev.instructors[0].name,
      'instructor resolved from the relations bag');

    // Per-class credit requirement must survive normalization. The live API
    // publishes `required_credits` (which is NOT always 1 — 4 of 705 real
    // events cost 2) and `credit_types`; neither was normalized, so the
    // client's per-class credit logic silently became dead code and every
    // affordability question collapsed to "do you hold any credits at all".
    assert.ok(ev.credits, 'normalized events carry a credit requirement');
    assert.ok(Number.isFinite(ev.credits.required), 'with a numeric cost');
    assert.ok(Array.isArray(ev.credits.acceptedTypeIds) && ev.credits.acceptedTypeIds.length > 0,
      'and the credit-type ids the class accepts');
    assert.ok(ev.credits.acceptedTypeIds.every((id) => typeof id === 'string'),
      'accepted type ids are STRINGS, like every other normalized id');
    assert.ok(events.some((e) => e.credits && e.credits.required === 2),
      'and a class costing more than one credit is representable end to end');
    log(`✅ GET /api/timetable returns ${events.length} normalized classes with relations resolved.`);
  }

  // --- 5. Normalized event detail w/ floor-plan layout ------------------------
  let eventId, layoutSlots;
  {
    eventId = 1000;
    const res = await fetch(`${BASE}/api/events/${eventId}`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(data.slots) && data.slots.length > 0, 'event detail should list bookable slots');
    assert.ok(data.event && data.event.studioId != null, 'event detail should identify its studio');
    studioIdForPrefs = data.event.studioId;

    const layoutRes = await fetch(`${BASE}/api/studios/${studioIdForPrefs}/layout`, authed());
    const layout = await layoutRes.json();
    assert.strictEqual(layoutRes.status, 200);
    assert.ok(Array.isArray(layout.slots) && layout.slots.length > 0, 'studio layout should carry floor-plan slots');
    layoutSlots = layout.slots;
    log(`✅ GET /api/events/${eventId} + /api/studios/${studioIdForPrefs}/layout return a floor plan (${layoutSlots.length} slots).`);
  }

  // --- 5b. The raw proxy passthrough stays removed ----------------------------
  {
    // `/api/proxy/*` let the client compose a provider's own URL and have the
    // server forward it. That only ever worked because the paths were
    // CodexFit's, and removing it was the acceptance criterion for the
    // provider-abstraction layer. A 404 here is the point of the assertion:
    // reintroducing the passthrough for "just one more CodexFit-only feature"
    // is exactly how it survived three previous attempts to delete it.
    for (const path of ['/api/proxy/events', '/api/proxy/profile']) {
      const res = await fetch(`${BASE}${path}`, authed());
      assert.strictEqual(res.status, 404, `${path} must not be routed`);
    }
    // Its replacements are named, capability-gated routes instead.
    const bundles = await fetch(`${BASE}/api/bundles`, authed());
    assert.strictEqual(bundles.status, 200, '/api/bundles serves the CodexFit bundle catalogue');
    log('✅ /api/proxy/* is gone; /api/bundles serves its last read caller.');
  }

  // --- 6. Auto-book: add to queue ---------------------------------------------
  {
    const preferredSlot = layoutSlots[0].id;
    const res = await fetch(`${BASE}/api/auto-book`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId,
        studioId: studioIdForPrefs,
        className: 'Ride 45',
        instructorName: 'ADAM',
        studioName: 'Ride Studio',
        locationName: 'Mortimer Street',
        startAt: new Date(Date.now() + 2 * 864e5).toISOString(),
        preferences: { preferredSlots: [preferredSlot], preferredRows: [], requiredCount: 1, bookAny: true },
        skipImmediate: true, // don't fire immediately; we trigger it explicitly below
      }),
    }));
    const data = await res.json();
    assert.strictEqual(res.status, 200, `add auto-book failed: ${JSON.stringify(data)}`);
    assert.strictEqual(data.success, true);
    assert.ok(data.id, 'auto-book add should return a queue row id');
    autoBookId = data.id;
    log('✅ POST /api/auto-book queues a booking (skipImmediate).');
  }

  // --- 7. Auto-book: list shows pending entry ---------------------------------
  {
    const res = await fetch(`${BASE}/api/auto-book`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    const row = data.find((b) => b.id === autoBookId);
    assert.ok(row, 'newly queued auto-book row should be listed');
    assert.strictEqual(row.status, 'pending');
    assert.deepStrictEqual(Object.keys(row.preferences).sort(), ['bookAny', 'preferredRows', 'preferredSlots', 'requiredCount'].sort());
    log('✅ GET /api/auto-book lists the queued row with status "pending".');
  }

  // --- 8. Simulate release → scheduler executes against the mock -------------
  {
    const res = await fetch(`${BASE}/api/simulate-release`, authed({ method: 'POST' }));
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    log('✅ POST /api/simulate-release triggers the scheduler.');
  }

  // --- 9. Poll until the scheduler resolves the booking -----------------------
  {
    const finalRow = await poll(async () => {
      const res = await fetch(`${BASE}/api/auto-book`, authed());
      const data = await res.json();
      const row = data.find((b) => b.id === autoBookId);
      return row && row.status !== 'pending' ? row : null;
    });
    assert.strictEqual(finalRow.status, 'success', `expected mock booking to succeed, got: ${JSON.stringify(finalRow)}`);
    log(`✅ Scheduler resolved queued booking → status "${finalRow.status}" against the mock backend.`);
  }

  // --- 10. Settings round-trip -------------------------------------------------
  {
    const settings = { advancedBooking: true, autoUpgradeEnabled: false, prefetchWeeks: 3 };
    const putRes = await fetch(`${BASE}/api/settings`, authed({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    }));
    assert.strictEqual(putRes.status, 200);

    const getRes = await fetch(`${BASE}/api/settings`, authed());
    const data = await getRes.json();
    assert.strictEqual(data.advancedBooking, true);
    assert.strictEqual(data.autoUpgradeEnabled, false);
    assert.strictEqual(data.prefetchWeeks, 3);
    log('✅ PUT/GET /api/settings round-trips correctly.');
  }

  // --- 11. Studio preferences (shared spot map) round-trip --------------------
  {
    const prefs = { preferredSlots: [layoutSlots[0].id, layoutSlots[1].id], preferredRows: [] };
    const putRes = await fetch(`${BASE}/api/studio-preferences/${studioIdForPrefs}`, authed({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences: prefs }),
    }));
    assert.strictEqual(putRes.status, 200);

    const getRes = await fetch(`${BASE}/api/studio-preferences`, authed());
    const data = await getRes.json();
    assert.deepStrictEqual(data[String(studioIdForPrefs)].preferredSlots, prefs.preferredSlots);
    log('✅ PUT/GET /api/studio-preferences round-trips the shared spot map.');
  }

  // --- 12. Normalized API surface (WP-N1/C1 — the client's new target contract) -
  // These back the normalized client methods added in client/src/api.js (WP-C1).
  // Asserting them here guards the exact shapes the migrating UI will consume.
  {
    // GET /api/gyms — public registry + capability flags (no auth).
    const gymsRes = await fetch(`${BASE}/api/gyms`);
    const gymsData = await gymsRes.json();
    assert.strictEqual(gymsRes.status, 200);
    assert.ok(Array.isArray(gymsData.gyms), 'gyms should be an array');
    const psycle = gymsData.gyms.find((g) => g.id === 'psycle-london');
    assert.ok(psycle && psycle.capabilities && psycle.capabilities.bookingWindow === 'rolling-weekly', 'psycle-london gym + capabilities present');
    assert.strictEqual(psycle.websiteUrl, 'https://psyclelondon.com/', 'public gym metadata carries the configured website URL');
    assert.ok(gymsData.gyms.find((g) => g.id === 'jab-boxing'), 'jab-boxing registry entry present');
    log(`✅ GET /api/gyms returns ${gymsData.gyms.length} gyms with capability flags.`);
  }
  {
    // Credit-based providers do not manufacture a membership from balances.
    const res = await fetch(`${BASE}/api/membership`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.membership, null);
    log('✅ GET /api/membership returns the normalized null membership for CodexFit.');
  }
  {
    // GET /api/timetable — normalized events.
    const res = await fetch(`${BASE}/api/timetable`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(data.events) && data.events.length > 0, 'normalized timetable returns events');
    const ev = data.events[0];
    assert.strictEqual(typeof ev.id, 'string', 'normalized event id is a string');
    assert.strictEqual(ev.gymId, 'psycle-london', 'event carries the resolved gymId');
    assert.ok(ev.layoutFormat, 'event has a layoutFormat');
    // 2026-08-31 regression guard: normalized list events MUST carry their
    // resolved relations. The real GET /events references them by id, so an
    // adapter that skips resolveEventRelations() yields events with no
    // discipline / studioName / instructors — which is what made the client
    // render a literal "CLASS" pill for every class after WP-C1 removed its own
    // relations merge. Asserting on `discipline` specifically because that is
    // the field the timetable card's discipline tag is derived from.
    const withDiscipline = data.events.filter((e) => e.discipline);
    assert.strictEqual(withDiscipline.length, data.events.length,
      'every normalized event resolves a discipline (else the UI shows "CLASS")');
    const sample = data.events[0];
    assert.ok(sample.studioName, 'studioName resolved from relations');
    assert.ok(sample.locationName, 'locationName resolved from relations');
    assert.ok(sample.instructors.length > 0 && sample.instructors[0].name,
      'instructors resolved from relations');
    assert.ok(sample.raw.event_type && sample.raw.event_type.group,
      'raw carries the inline-resolved event_type the client still reads');
    log(`✅ GET /api/timetable returns ${data.events.length} normalized events, all with resolved relations.`);
  }
  {
    // GET /api/events/:id — normalized event + slots.
    const res = await fetch(`${BASE}/api/events/${eventId}`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(data.event && Array.isArray(data.slots) && data.slots.length > 0, 'normalized event details include slots');
    assert.strictEqual(typeof data.slots[0].isAvailable, 'boolean', 'normalized slot availability is a boolean');
    assert.ok(Array.isArray(data.objects), 'event details always carry a normalized objects array (WP-C5)');
    log(`✅ GET /api/events/${eventId} returns ${data.slots.length} normalized slots.`);
  }
  {
    // GET /api/studios/:id/layout — event-independent studio floor plan (WP-C5/Q12).
    const res = await fetch(`${BASE}/api/studios/138/layout`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(data.slots) && data.slots.length > 0, 'studio 138 (has a mock layout) returns normalized slots');
    // WP-C5: non-bookable floor fixtures (podium) come back normalized on the
    // same response, so the shared renderer never touches a raw provider shape.
    assert.ok(Array.isArray(data.objects) && data.objects.length > 0, 'layout objects normalized alongside slots');
    assert.strictEqual(typeof data.objects[0].x, 'number', 'layout object carries numeric coordinates');
    const noLayoutRes = await fetch(`${BASE}/api/studios/140/layout`, authed());
    const noLayoutData = await noLayoutRes.json();
    assert.deepStrictEqual(noLayoutData.slots, [], 'studio with no layout returns [] cleanly, not an error');
    assert.deepStrictEqual(noLayoutData.objects, [], 'and empty objects, not undefined');
    log(`✅ GET /api/studios/138/layout returns ${data.slots.length} normalized slots; a no-layout studio returns [].`);
  }
  {
    // --- WP-C2 slice 1a: per-request active-gym resolution over real HTTP ------
    // The header is an authorisation boundary, not a preference: it selects which
    // gym's session, credentials and calendar token db.js resolves. Pinning both
    // that it works for a linked gym and that it is refused for an unlinked one.
    // Establish the state this block asserts rather than inheriting it. The dev
    // login seeds EVERY enabled gym onto the dev account (so the dev environment
    // is genuinely multi-gym), which means "jab-boxing is unlinked" is no longer
    // ambient truth — unlink it here, explicitly, so the 403 below is testing
    // the authorisation boundary and not a side effect of the login path.
    await fetch(`${BASE}/api/my-gyms/jab-boxing`, { ...authed(), method: 'DELETE' });

    const my = await (await fetch(`${BASE}/api/my-gyms`, authed())).json();
    assert.ok(Array.isArray(my.gyms) && my.gyms.length >= 1, 'account lists its linked gyms');
    assert.ok(!my.gyms.some((g) => g.gym_id === 'jab-boxing'), 'jab-boxing is unlinked for this block');
    assert.strictEqual(my.activeGymId, 'psycle-london', 'account resolves to the default gym');

    // A header naming a linked gym is honoured and changes nothing observable
    // for a single-gym account — the no-op property that makes this safe to ship.
    const okRes = await fetch(`${BASE}/api/timetable`, {
      headers: { ...authed().headers, 'x-gym-id': 'psycle-london' },
    });
    assert.strictEqual(okRes.status, 200, 'a linked gym in x-gym-id is accepted');

    // A header naming a gym this account is NOT linked to must be refused
    // outright — never silently served as the default gym.
    const badRes = await fetch(`${BASE}/api/timetable`, {
      headers: { ...authed().headers, 'x-gym-id': 'jab-boxing' },
    });
    assert.strictEqual(badRes.status, 403, 'an unlinked gym in x-gym-id is a 403, not a silent fallback');

    // Same for garbage.
    const junkRes = await fetch(`${BASE}/api/timetable`, {
      headers: { ...authed().headers, 'x-gym-id': 'definitely-not-a-gym' },
    });
    assert.strictEqual(junkRes.status, 403, 'an unknown gym id is refused too');

    // And switching to an unlinked gym is refused at the switch endpoint.
    const switchRes = await fetch(`${BASE}/api/my-gyms/active`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gymId: 'jab-boxing' }),
    }));
    assert.strictEqual(switchRes.status, 403, 'cannot switch to a gym the account has not linked');
    log('✅ Active-gym: linked gym accepted, unlinked/unknown refused (403) on both header and switch.');
  }
  {
    // --- Admin password reset: the account-recovery escape hatch ---------------
    // Self-service recovery does not exist (Decision D5 removed the gym-login
    // mechanism), so this is the ONLY route back into a locked-out account.
    //
    // Runs against a DEDICATED throwaway account, not dev@psycle.com: a reset
    // clears the account's gym session by design, which correctly 401s every
    // later request in this suite. Found that the hard way.
    const adminLogin = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' }),
    });
    const adminData = await adminLogin.json();
    assert.strictEqual(adminLogin.status, 200, `admin login failed: ${JSON.stringify(adminData)}`);
    const asAdmin = (extra = {}) => ({ ...extra, headers: {
      authorization: `Bearer ${adminData.token}`, 'content-type': 'application/json', ...(extra.headers || {}) } });

    // A fresh account, given a gym link so the credential-clearing path is real.
    const victimEmail = `reset-target-${Date.now()}@test.local`;
    await fetch(`${BASE}/api/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: victimEmail, password: 'original-password' }),
    });
    const users = await (await fetch(`${BASE}/api/admin/users`, asAdmin())).json();
    const target = (users.users || users).find(u => u.email === victimEmail);
    assert.ok(target, 'the new account should be listed in the admin panel');
    await fetch(`${BASE}/api/admin/users/${target.id}/link-gym`,
      asAdmin({ method: 'POST', body: JSON.stringify({ gymId: 'psycle-london' }) }));

    // Reset WITHOUT clearing gym credentials.
    const keep = await fetch(`${BASE}/api/admin/users/${target.id}/reset-password`,
      asAdmin({ method: 'POST', body: JSON.stringify({ resetGymCredentials: false }) }));
    const keepData = await keep.json();
    assert.strictEqual(keep.status, 200, `reset failed: ${JSON.stringify(keepData)}`);
    assert.ok(keepData.tempPassword && keepData.tempPassword.length >= 16,
      'a strong temporary password is generated server-side — the admin never chooses it');
    assert.deepStrictEqual(keepData.clearedGyms, [], 'opting out leaves gym credentials alone');

    // The new password works, and the old one no longer does.
    const login = (password) => fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: victimEmail, password }),
    });
    assert.strictEqual((await login(keepData.tempPassword)).status, 200, 'the temporary password logs in');
    assert.strictEqual((await login('original-password')).status, 401, 'the old password is dead');

    // Reset WITH the default gym-credential clearing.
    const clear = await fetch(`${BASE}/api/admin/users/${target.id}/reset-password`,
      asAdmin({ method: 'POST', body: JSON.stringify({}) }));
    const clearData = await clear.json();
    assert.strictEqual(clear.status, 200);
    assert.ok(clearData.clearedGyms.includes('psycle-london'),
      'clearing gym credentials is the DEFAULT — an account that needed recovering is not assumed safe');
    assert.notStrictEqual(clearData.tempPassword, keepData.tempPassword, 'each reset issues a fresh password');

    // Unknown user, and unauthenticated callers, are both refused.
    assert.strictEqual((await fetch(`${BASE}/api/admin/users/999999/reset-password`,
      asAdmin({ method: 'POST', body: '{}' }))).status, 404);
    assert.strictEqual((await fetch(`${BASE}/api/admin/users/${target.id}/reset-password`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

    log('✅ Admin password reset issues a fresh password, clears gym credentials by default, and is admin-only.');
  }
  {
    // GET /api/credits — normalized credits envelope (CodexFit derives from profile).
    const res = await fetch(`${BASE}/api/credits`, authed());
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(data.credits), 'credits should be an array');
    log(`✅ GET /api/credits returns a normalized credits array (${data.credits.length}).`);
  }
  {
    // POST /api/book + POST /api/cancel — normalized write round-trip. Safe: the
    // harness backs up/restores mock_bookings.dbjson around the whole run.
    const bookRes = await fetch(`${BASE}/api/book`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId, slotIds: [String(layoutSlots[0].id)] }),
    }));
    const booking = await bookRes.json();
    assert.strictEqual(bookRes.status, 200);
    assert.strictEqual(booking.ok, true, `normalized book should succeed: ${JSON.stringify(booking)}`);
    assert.ok(booking.bookingId, 'normalized book returns a bookingId');

    // GET /api/bookings — the just-created booking should be listed. The mock
    // embeds a full `event` per booking (its own dev-only convention), and
    // listBookings() now surfaces that (real API: same result via a different
    // route — a top-level `relations.events[]` join — see providers/codexfit.js
    // listBookings doc comment; both paths were confirmed via a real capture
    // 2026-07-03, since deleted). So `event` should be present and populated,
    // not the "always absent" assumption an earlier pass made.
    const listRes = await fetch(`${BASE}/api/bookings`, authed());
    const listData = await listRes.json();
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listData.bookings), 'bookings should be an array');
    const listed = listData.bookings.find((b) => b.bookingId === booking.bookingId);
    assert.ok(listed, 'the just-booked entry appears in GET /api/bookings');
    assert.strictEqual(listed.isWaitlist, false);
    assert.ok(listed.event && listed.event.name, 'listBookings resolves the embedded/joined event, not just bare booking fields');

    // GET /api/waitlists — shape check (mock has no waitlist handler, so this
    // exercises the empty-list path through the real route + adapter).
    const wlRes = await fetch(`${BASE}/api/waitlists`, authed());
    const wlData = await wlRes.json();
    assert.strictEqual(wlRes.status, 200);
    assert.ok(Array.isArray(wlData.waitlists), 'waitlists should be an array');
    log(`✅ GET /api/bookings + /api/waitlists return normalized lists (${listData.bookings.length} booking(s), ${wlData.waitlists.length} waitlist(s)).`);

    const cancelRes = await fetch(`${BASE}/api/cancel`, authed({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookingId: booking.bookingId }),
    }));
    const cancelData = await cancelRes.json();
    assert.strictEqual(cancelRes.status, 200);
    assert.strictEqual(cancelData.ok, true, 'normalized cancel should succeed');
    log('✅ POST /api/book + /api/cancel complete a normalized write round-trip.');
  }

  // --- 13. Cleanup: remove the queue entry -------------------------------------
  {
    const res = await fetch(`${BASE}/api/auto-book/${autoBookId}`, authed({ method: 'DELETE' }));
    assert.strictEqual(res.status, 200);
    log('✅ DELETE /api/auto-book/:id removes the queue entry.');
  }

  log('\n🎉 ALL PSYCLE REGRESSION CHECKS PASSED.');
}

async function main() {
  try {
    await run();
  } catch (err) {
    failed = true;
    console.error('\n❌ REGRESSION FAILURE:', err.message);
    console.error(err.stack);
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
    for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    // Restore the real dev mock-bookings fixture (or remove the one the test run created).
    if (hadMockBookings) {
      fs.copyFileSync(MOCK_BOOKINGS_BACKUP, MOCK_BOOKINGS_PATH);
      fs.unlinkSync(MOCK_BOOKINGS_BACKUP);
    } else if (fs.existsSync(MOCK_BOOKINGS_PATH)) {
      fs.unlinkSync(MOCK_BOOKINGS_PATH);
    }
    process.exit(failed ? 1 : 0);
  }
}

main();
