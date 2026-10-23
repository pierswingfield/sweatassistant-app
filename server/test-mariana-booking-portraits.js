// MarianaTek booking portrait enrichment (mock/fixture-backed, read-only to providers).
// The reservation fixture intentionally omits class_session.instructors, matching
// the captured production response. Class identity must be the only join key.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const { getProvider } = require('./providers');
const scheduleCache = require('./schedule-cache');

const classFixture = require('./__fixtures__/marianatek/classes-list.json').results
  .find((row) => (row.instructors || []).some((i) => String(i.id) === '6255'));
assert.ok(classFixture, 'fixture includes the published Nickol portrait');

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

function reservation(id, type, slotId) {
  const { instructors: _omitted, ...classSession } = JSON.parse(JSON.stringify(classFixture));
  return {
    id,
    reservation_type: type,
    is_booked_for_me: type === 'standard',
    guest_email: type === 'standard' ? null : 'guest@example.test',
    is_upcoming: true,
    spot: { id: slotId, name: slotId },
    class_session: classSession,
  };
}

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('exact class id enrichment preserves booking identity and portraits', async () => {
  const mt = getProvider('jab-boxing');
  scheduleCache.invalidate('marianatek:reservation-classes:jab-boxing:');
  const rows = [reservation('booking-self', 'standard', 'seat-1'), reservation('booking-guest', 'waitlist', 'seat-2')];
  const classListCalls = [];
  mt.request = async (path) => path.startsWith('/me/reservations?') ? response({ results: rows }) : response({});
  mt.classListRequest = async (path) => {
    classListCalls.push(path);
    // Same person/name is deliberately present on a different class id. It
    // must not be used to satisfy the booking's portrait.
    const decoy = { ...classFixture, id: 'different-class-id', instructors: [{ id: '9999', name: 'Wrong Person', photo_urls: { thumbnail_url: 'https://wrong.invalid/photo.png' } }] };
    return response({ results: [decoy, classFixture], meta: { pagination: { pages: 1 } } });
  };

  const bookings = await mt.listBookings({ accessToken: 'fixture-session' });
  assert.strictEqual(bookings.length, 1);
  assert.strictEqual(bookings[0].bookingId, 'booking-self');
  assert.strictEqual(bookings[0].slotId, 'seat-1');
  assert.strictEqual(bookings[0].eventId, String(classFixture.id));
  assert.strictEqual(bookings[0].event.instructors[0].name, 'Nickol');
  assert.match(bookings[0].event.instructors[0].thumbUrl, /\/api\/instructor-photo\/jab-boxing\/6255\?size=thumb&v=/);
  assert.strictEqual(classListCalls.length, 1, 'one bounded class-list lookup for the two reservations');

  const waitlists = await mt.listWaitlists({ accessToken: 'fixture-session' });
  assert.strictEqual(waitlists.length, 1);
  assert.strictEqual(waitlists[0].bookingId, 'booking-guest');
  assert.strictEqual(waitlists[0].slotId, 'seat-2');
  assert.strictEqual(waitlists[0].event.instructors[0].name, 'Nickol');
  assert.strictEqual(classListCalls.length, 1, 'shared cache prevents a duplicate lookup');
});

check('class-list failure preserves the booking with no invented portrait', async () => {
  const mt = getProvider('jab-boxing');
  scheduleCache.invalidate('marianatek:reservation-classes:jab-boxing:');
  const row = reservation('booking-preserved', 'standard', 'seat-3');
  mt.request = async (path) => path.startsWith('/me/reservations?') ? response({ results: [row] }) : response({});
  mt.classListRequest = async () => { throw new Error('fixture class list unavailable'); };

  const bookings = await mt.listBookings({ accessToken: 'fixture-session-failure' });
  assert.strictEqual(bookings.length, 1);
  assert.strictEqual(bookings[0].bookingId, 'booking-preserved');
  assert.strictEqual(bookings[0].slotId, 'seat-3');
  assert.deepStrictEqual(bookings[0].event.instructors, []);
});

(async () => {
  console.log('\n🧪 MarianaTek booking portrait enrichment suite\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} portrait enrichment checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed ? 1 : 0);
})();
