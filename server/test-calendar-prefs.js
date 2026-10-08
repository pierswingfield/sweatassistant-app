// U4-16: calendar preferences, targeted VALARMs and booking-window events.
//  1. Legacy blobs (includeTentative / alarm) migrate to the new flags without
//     changing what the feed contains; saving drops the legacy keys.
//  2. VALARMs are targeted: booked = 2h/12h per checkboxes; waitlist and
//     Auto-Book NEVER get one; booking-window events get exactly one, 15 min.
//  3. Booking-window events exist only for rolling-weekly gyms (by policy, not
//     id), have deterministic UIDs, and the feed keeps CRLF/VTIMEZONE shape.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { DateTime } = require('luxon');
const { normalizeCalendarPrefs, applyCalendarPatch } = require('./calendar-prefs');
const calendar = require('./calendar');

// ── 1. migration ─────────────────────────────────────────────────────────────
let p = normalizeCalendarPrefs({ enabled: true, includeTentative: true, alarm: 'both' });
assert.deepStrictEqual(p, { includeWaitlists: true, includeAutoBook: true, remindBookingWindow: false, reminders: { twoHour: true, cancelWindow: true } });
p = normalizeCalendarPrefs({ enabled: true });
assert.deepStrictEqual(p, { includeWaitlists: false, includeAutoBook: false, remindBookingWindow: false, reminders: { twoHour: false, cancelWindow: false } });
for (const [alarm, two, cancel] of [['none', false, false], ['2h', true, false], ['penalty', false, true], ['both', true, true]]) {
  const r = normalizeCalendarPrefs({ alarm }).reminders;
  assert.deepStrictEqual([r.twoHour, r.cancelWindow], [two, cancel], `alarm=${alarm}`);
}
// New keys win over legacy ones once present.
p = normalizeCalendarPrefs({ includeTentative: true, includeWaitlists: false, alarm: 'both', reminders: { twoHour: false, cancelWindow: true } });
assert.strictEqual(p.includeWaitlists, false);
assert.strictEqual(p.includeAutoBook, true);
assert.deepStrictEqual(p.reminders, { twoHour: false, cancelWindow: true });
// Saving folds legacy into new, keeps `enabled`, drops the legacy keys.
let saved = applyCalendarPatch({ enabled: true, includeTentative: true, alarm: '2h' }, { remindBookingWindow: true });
assert.strictEqual(saved.enabled, true);
assert.ok(!('includeTentative' in saved) && !('alarm' in saved), 'legacy keys dropped on save');
assert.deepStrictEqual(saved.reminders, { twoHour: true, cancelWindow: false });
assert.strictEqual(saved.includeWaitlists && saved.includeAutoBook && saved.remindBookingWindow, true);
// Legacy request body still works.
saved = applyCalendarPatch({ enabled: true }, { includeTentative: true, alarm: 'penalty' });
assert.deepStrictEqual([saved.includeWaitlists, saved.includeAutoBook, saved.reminders.cancelWindow, saved.reminders.twoHour], [true, true, true, false]);
// Non-boolean junk is ignored.
saved = applyCalendarPatch({ enabled: true }, { includeWaitlists: 'yes', reminders: { twoHour: 1 } });
assert.deepStrictEqual([saved.includeWaitlists, saved.reminders.twoHour], [false, false]);

// ── 2. targeted VALARMs ──────────────────────────────────────────────────────
const PSY = 'psycle-london';
const JAB = 'jab-boxing';
const row = (status, id, gym = PSY) => ({
  event_id: id, gym_id: gym, status, start_at: '2099-03-02T18:00:00', duration_min: 45,
  group_name: 'Ride', class_name: 'Ride', instructor_name: 'Sinead Murphy', location_name: 'Oxford Circus',
  slot_label: status === 'confirmed' ? '7' : null, sequence: 0,
});
const rows = [row('confirmed', 1), row('waitlist', 2), row('autobook', 3), row('confirmed', 4, JAB)];
const vevents = (ics) => ics.split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0]);
const alarmsOf = (v) => (v.match(/TRIGGER:[^\r\n]+/g) || []);
const byUid = (evs, id) => evs.find((v) => v.includes(`app-7-${id}@`));

let ics = calendar.serializeCalendar(7, rows, {}, { twoHour: true, cancelWindow: true }, []);
let evs = vevents(ics);
assert.deepStrictEqual(alarmsOf(byUid(evs, 1)), ['TRIGGER:-PT2H', 'TRIGGER:-PT12H']);
assert.deepStrictEqual(alarmsOf(byUid(evs, 4)), ['TRIGGER:-PT2H', 'TRIGGER:-PT12H']);
assert.deepStrictEqual(alarmsOf(byUid(evs, 2)), [], 'waitlist never has an alarm');
assert.deepStrictEqual(alarmsOf(byUid(evs, 3)), [], 'auto-book never has an alarm');
ics = calendar.serializeCalendar(7, rows, {}, { twoHour: false, cancelWindow: true }, []);
assert.deepStrictEqual(alarmsOf(byUid(vevents(ics), 1)), ['TRIGGER:-PT12H']);
ics = calendar.serializeCalendar(7, rows, {}, { twoHour: false, cancelWindow: false }, []);
assert.strictEqual(alarmsOf(ics).length, 0, 'no reminders ticked, no VALARM anywhere');

// ── 3. booking-window events ─────────────────────────────────────────────────
// Wed 2099-03-04 10:00 London -> the next Psycle release is Mon 2099-03-09 12:00.
const now = DateTime.fromISO('2099-03-04T10:00:00', { zone: 'Europe/London' });
const wins = calendar.bookingWindowEvents([PSY, JAB], now);
assert.ok(wins.length > 0);
assert.ok(wins.every((w) => w.gymId === PSY), 'per-class gym (JAB) gets no booking-window events');
assert.strictEqual(wins[0].start.toISO(), DateTime.fromISO('2099-03-09T12:00:00', { zone: 'Europe/London' }).toISO());
assert.ok(wins.every((w) => w.start.weekday === 1 && w.start > now));

ics = calendar.serializeCalendar(7, rows, {}, { twoHour: true, cancelWindow: true }, wins);
evs = vevents(ics);
const winEvs = evs.filter((v) => v.includes('-bw-'));
assert.strictEqual(winEvs.length, wins.length);
for (const v of winEvs) {
  assert.deepStrictEqual(alarmsOf(v), ['TRIGGER:-PT15M'], 'window event: 15 minute reminder only');
  assert.ok(/SUMMARY:Psycle booking window opens/.test(v), 'gym name from gyms.config');
}
assert.ok(winEvs[0].includes('UID:app-7-bw-psycle-london-20990309@'));
assert.ok(winEvs[0].includes('DTSTART;TZID=Europe/London:20990309T120000'));
// Stable UIDs across regenerations (and when the clock moves within the same week).
const uids = (i) => vevents(i).map((v) => v.match(/UID:[^\r\n]+/)[0]);
const later = calendar.bookingWindowEvents([PSY], now.plus({ hours: 20 }));
const ics2 = calendar.serializeCalendar(7, rows, {}, { twoHour: true, cancelWindow: true }, later);
assert.deepStrictEqual(uids(ics2), uids(ics), 'UIDs identical between refreshes');
assert.strictEqual(new Set(uids(ics)).size, uids(ics).length, 'no duplicate UIDs');
// Once the release has passed, that instant drops off and the next is UID-distinct.
const after = calendar.bookingWindowEvents([PSY], DateTime.fromISO('2099-03-09T12:00:01', { zone: 'Europe/London' }));
assert.strictEqual(after[0].dateKey, '20990316');
// Feed shape is intact.
assert.ok(ics.includes('BEGIN:VTIMEZONE') && ics.includes('TZID:Europe/London') && ics.endsWith('END:VCALENDAR\r\n'));
assert.ok(!/[^\r]\n/.test(ics.replace(/\r\n/g, '')), 'CRLF line endings only');

console.log('✅ U4-16 calendar prefs migrate, VALARMs are targeted, booking-window events are stable.');
