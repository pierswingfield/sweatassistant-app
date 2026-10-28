// A rolling-weekly timetable must use the current, per-gym provider profile.
// This reproduces a stale cached cutoff advancing a Wednesday class's release
// to the following Monday, and covers the profile route and provider failure.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'timetable-profile-refresh-test-secret';
// The fixture cutoff is relative to this Monday after the release; freeze the
// clock so its intended fifteen-day window does not drift as the suite ages.
const RealDate = Date;
const fixtureNow = RealDate.parse('2026-10-19T13:00:00Z');
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
  static now() { return fixtureNow; }
};

const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const tmpDb = path.join(os.tmpdir(), `timetable-profile-refresh-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('./db');
const testkit = require('./testkit');
const { encrypt } = require('./crypto');
const { getProvider } = require('./providers');
const router = require('./routes-normalized');

const PSYCLE = 'psycle-london';
const JAB = 'jab-boxing';
const OLD_PROFILE = {
  id: 'fixture-profile', first_name: 'Test', last_name: 'Member',
  booking_cutoff: '2026-10-20T00:00:00Z',
  extended_cutoff: '2026-10-20T00:00:00Z',
};
const CURRENT_PROFILE = {
  id: 'fixture-profile', first_name: 'Test', last_name: 'Member',
  booking_cutoff: '2026-11-03T00:00:00Z',
  extended_cutoff: '2026-11-03T00:00:00Z',
};
const WEDNESDAY_EVENTS = [
  { id: 'early', gymId: PSYCLE, startAt: '2026-10-21T06:30:00+01:00' },
  { id: 'evening', gymId: PSYCLE, startAt: '2026-10-21T18:30:00+01:00' },
];

let server;
let base;
let failed = 0;

function cleanup() {
  try { server && server.close(); } catch (_) {}
  for (const file of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {}
  }
}

function saveProfile(gymId, profile, syncedAt) {
  db.cacheUserProfile(userId, profile, gymId);
  if (syncedAt) {
    db.db.prepare('UPDATE user_gyms SET profile_synced_at = ? WHERE user_id = ? AND gym_id = ?')
      .run(syncedAt, userId, gymId);
  }
}

async function call(pathname, gymId = PSYCLE) {
  return fetch(`${base}${pathname}`, {
    headers: { authorization: `Bearer ${token}`, 'x-gym-id': gymId },
  });
}

const userId = testkit.createUser(db, `profile-refresh-${process.pid}@test.local`, encrypt('test-password'), PSYCLE);
db.upsertUserGym(userId, JAB, {
  session_json: JSON.stringify({ accessToken: 'jab-test-session' }),
  profile_json: JSON.stringify({ marker: 'jab-profile-must-stay' }),
});
db.upsertUserGym(userId, PSYCLE, {
  session_json: JSON.stringify({ accessToken: 'psycle-test-session' }),
});
const token = jwt.sign({ userId, email: `profile-refresh-${process.pid}@test.local` }, process.env.JWT_SECRET);

const psycle = getProvider(PSYCLE);
const jab = getProvider(JAB);
const originalRequests = new Map([[PSYCLE, psycle.request], [JAB, jab.request]]);
const originalTimetables = new Map([[PSYCLE, psycle.fetchTimetable], [JAB, jab.fetchTimetable]]);
let profileBody = CURRENT_PROFILE;
let profileRequests = 0;
let profileError = null;
psycle.request = async (pathname) => {
  assert.strictEqual(pathname, '/profile', 'only the local profile fixture is requested');
  profileRequests++;
  if (profileError) throw profileError;
  return { ok: true, json: async () => ({ data: profileBody }) };
};
psycle.fetchTimetable = async () => WEDNESDAY_EVENTS;
jab.request = async () => { throw new Error('profile-independent JAB path must not fetch a profile'); };
jab.fetchTimetable = async () => [{
  id: 'jab-event', gymId: JAB, startAt: '2026-10-21T06:30:00+01:00', releaseAt: '2026-10-19T13:30:00+01:00',
}];

function cachedCutoff(gymId = PSYCLE) {
  const row = db.db.prepare('SELECT profile_json FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
  return JSON.parse(row.profile_json || '{}').booking_cutoff;
}

(async () => {
  try {
    saveProfile(PSYCLE, OLD_PROFILE, '2026-10-11T14:18:05.818Z');
    const app = express();
    app.use('/api', router);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;

    // Timetable-first must refresh the profile itself; the UI need not have
    // visited GET /api/profile before asking for these class releases.
    const timetableResponse = await call('/api/timetable?startDate=2026-10-21&endDate=2026-10-22&refresh=1');
    assert.strictEqual(timetableResponse.status, 200);
    const timetable = await timetableResponse.json();
    assert.deepStrictEqual(timetable.events.map((event) => event.releaseAt), [
      '2026-10-12T12:00:00.000+01:00',
      '2026-10-12T12:00:00.000+01:00',
    ], 'the fresh 15-day profile window opens both Wednesday classes before the class date');
    assert.strictEqual(profileRequests, 1, 'timetable-first reads the provider profile once');
    assert.strictEqual(cachedCutoff(), CURRENT_PROFILE.booking_cutoff,
      `the fresh profile is cached for the explicit Psycle gym (requests=${profileRequests}, cached=${cachedCutoff()})`);

    // A successful profile read also persists the raw response with its gym
    // context, without overwriting another linked gym's snapshot.
    saveProfile(PSYCLE, OLD_PROFILE, '2026-10-11T14:18:05.818Z');
    const jabProfileBefore = db.db.prepare('SELECT profile_json FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(userId, JAB).profile_json;
    profileBody = { ...CURRENT_PROFILE, booking_cutoff: '2026-11-10T00:00:00Z', extended_cutoff: '2026-11-10T00:00:00Z' };
    psycle.invalidateProfile({ accessToken: 'psycle-test-session' });
    const profileResponse = await call('/api/profile');
    assert.strictEqual(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.strictEqual(profile.raw.booking_cutoff, profileBody.booking_cutoff);
    assert.strictEqual(cachedCutoff(), profileBody.booking_cutoff, 'GET /api/profile persists its raw profile');
    const jabProfileAfter = db.db.prepare('SELECT profile_json FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(userId, JAB).profile_json;
    assert.strictEqual(jabProfileAfter, jabProfileBefore, 'Psycle profile refresh leaves JAB profile untouched');

    // If the required per-user profile cannot be refreshed, do not return events
    // with a stale cutoff (or silently turn an unknown release into Quick-Book).
    saveProfile(PSYCLE, OLD_PROFILE, '2026-10-11T14:18:05.818Z');
    psycle.invalidateProfile({ accessToken: 'psycle-test-session' });
    profileError = Object.assign(new Error('mock provider profile unavailable'), { status: 503 });
    const failedTimetable = await call('/api/timetable?startDate=2026-10-21&endDate=2026-10-22&refresh=1');
    assert.strictEqual(failedTimetable.status, 503, 'a missing required profile surfaces the provider failure');
    assert.strictEqual(cachedCutoff(), OLD_PROFILE.booking_cutoff, 'a failed read does not overwrite the last profile snapshot');

    // Per-class releases are self-contained; an unrelated profile outage must
    // not block a route whose event already has its published release instant.
    const jabResponse = await call('/api/timetable?startDate=2026-10-21&endDate=2026-10-22&refresh=1', JAB);
    assert.strictEqual(jabResponse.status, 200);
    const jabEvents = await jabResponse.json();
    assert.strictEqual(jabEvents.events[0].releaseAt, '2026-10-19T13:30:00+01:00');
    console.log('✅ timetable/profile refresh, stale cutoff, gym isolation, and provider-failure regressions passed.');
  } catch (err) {
    failed = 1;
    console.error('❌ timetable profile refresh regression failed:', err.stack || err.message);
  } finally {
    psycle.request = originalRequests.get(PSYCLE);
    jab.request = originalRequests.get(JAB);
    psycle.fetchTimetable = originalTimetables.get(PSYCLE);
    jab.fetchTimetable = originalTimetables.get(JAB);
    cleanup();
  }
  process.exit(failed);
})();
