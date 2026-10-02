// Gym-local timezone resolution + adapter emission (pure; no network).
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
const assert = require('assert');
const { DateTime } = require('luxon');
const { resolveZone, isValidZone, toZonedISO } = require('./providers/timezone');
const { getGymConfig } = require('./gyms.config');
const { getProvider } = require('./providers');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };

t('precedence: config location override > provider zone > gym default', () => {
  const gym = { timezone: 'Europe/London', locationTimezones: { 7: 'America/Chicago' } };
  assert.strictEqual(resolveZone(gym, { locationId: '7', providerZone: 'America/New_York' }), 'America/Chicago');
  assert.strictEqual(resolveZone(gym, { locationId: '8', providerZone: 'America/New_York' }), 'America/New_York');
  assert.strictEqual(resolveZone(gym, { locationId: '8' }), 'Europe/London');
  assert.strictEqual(resolveZone(gym), 'Europe/London');
});
t('junk zones fall through to the next tier', () => {
  const gym = { timezone: 'America/New_York', locationTimezones: { 1: 'Not/AZone' } };
  assert.strictEqual(resolveZone(gym, { locationId: 1, providerZone: 'garbage' }), 'America/New_York');
  assert.strictEqual(resolveZone({ timezone: 'nope' }), 'UTC');
  assert.ok(!isValidZone('') && !isValidZone(null) && isValidZone('Europe/London'));
});
t('DST boundaries: London and New York', () => {
  // London springs forward 2026-03-29 01:00 UTC; NY 2026-03-08 07:00 UTC.
  assert.strictEqual(toZonedISO('2026-03-28T19:30:00', 'Europe/London'), '2026-03-28T19:30:00+00:00');
  assert.strictEqual(toZonedISO('2026-03-29T19:30:00', 'Europe/London'), '2026-03-29T19:30:00+01:00');
  assert.strictEqual(toZonedISO('2026-03-08T14:15:00Z', 'America/New_York'), '2026-03-08T10:15:00-04:00');
  assert.strictEqual(toZonedISO('2026-03-07T14:15:00Z', 'America/New_York'), '2026-03-07T09:15:00-05:00');
  assert.strictEqual(toZonedISO('2026-11-01T14:15:00Z', 'America/New_York'), '2026-11-01T09:15:00-05:00');
});
t('Aarmy bug: 14:15Z is a 09:15 class in New York (offset kept, instant preserved)', () => {
  const p = getProvider('aarmy');
  const e = p.mapClassToEvent({
    id: 1, name: 'x', start_datetime: '2026-01-12T14:15:00Z',
    location: { id: 5, name: 'NoHo', timezone: 'America/New_York' }, class_type: { name: 'Ride', duration: 45 },
  });
  assert.strictEqual(e.timeZone, 'America/New_York');
  assert.strictEqual(e.startAt, '2026-01-12T09:15:00-05:00');
  assert.strictEqual(DateTime.fromISO(e.startAt).toUTC().toISO(), '2026-01-12T14:15:00.000Z');
  assert.strictEqual(e.endAt, '2026-01-12T10:00:00-05:00');
});
t('MarianaTek falls back to gym zone when the provider publishes none or junk', () => {
  const p = getProvider('aarmy');
  const e = p.mapClassToEvent({ id: 2, name: 'x', start_datetime: '2026-07-12T13:15:00Z', location: { id: 5, timezone: 'bad' } });
  assert.strictEqual(e.timeZone, 'America/New_York');
  assert.strictEqual(e.startAt, '2026-07-12T09:15:00-04:00');
});
t('CodexFit (Psycle): naive start_at read in the config zone, offset emitted', () => {
  const p = getProvider('psycle-london');
  const e = p.mapEventToNormalized({ id: 3, name: 'x', start_at: '2026-07-01T19:30:00', duration: 45, studio_id: 1 });
  assert.strictEqual(e.timeZone, getGymConfig('psycle-london').timezone);
  assert.strictEqual(e.startAt, '2026-07-01T19:30:00+01:00');
  assert.strictEqual(e.endAt, '2026-07-01T20:15:00.000+01:00');
});
console.log(`\n🎉 ${n}/${n} timezone checks passed.`);
