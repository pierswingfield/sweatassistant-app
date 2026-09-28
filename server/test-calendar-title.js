// C3-29: a class with no instructor (JAB Recovery) appeared in the calendar as
// "JAB: Recovery (Members) with Instructor, SW1" because buildTitle fell back to
// the literal placeholder 'Instructor'. With no real name the " with ..." clause
// must be omitted entirely, for both gyms, and the format must otherwise match
// the named-instructor titles.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { buildTitle } = require('./calendar');

const JAB = 'jab-boxing';
const PSY = 'psycle-london';
const row = (o) => ({ status: 'confirmed', group_name: 'Ride', location_name: '', instructor_name: '', ...o });

assert.strictEqual(typeof buildTitle, 'function', 'buildTitle must be exported for testing');

// Named instructor: unchanged format (first name only).
assert.strictEqual(buildTitle(row({ gym_id: PSY, group_name: 'ride', instructor_name: 'Sinead Murphy', location_name: 'Psycle Oxford Circus' })),
  'Psycle: Ride with Sinead, Oxford Circus');
assert.strictEqual(buildTitle(row({ gym_id: JAB, group_name: 'Boxing', instructor_name: 'George Davies', location_name: 'SW1' })),
  'JAB: Boxing with George, SW1');

// No instructor, all the shapes the placeholder can take.
for (const missing of ['', null, undefined, '  ', 'Instructor', 'instructor', 'TBA', 'tbc']) {
  assert.strictEqual(buildTitle(row({ gym_id: JAB, group_name: 'Recovery (Members)', instructor_name: missing, location_name: 'SW1' })),
    'JAB: Recovery (Members), SW1', `JAB, instructor=${JSON.stringify(missing)}`);
  assert.strictEqual(buildTitle(row({ gym_id: PSY, group_name: 'Ride', instructor_name: missing, location_name: 'Psycle Oxford Circus' })),
    'Psycle: Ride, Oxford Circus', `Psycle, instructor=${JSON.stringify(missing)}`);
}
// No instructor and no location, tentative prefix kept.
assert.strictEqual(buildTitle(row({ gym_id: JAB, group_name: 'Recovery', status: 'waitlist' })), '[Tentative] JAB: Recovery');
console.log('✅ Calendar titles omit the instructor clause when there is no real name (both gyms).');
