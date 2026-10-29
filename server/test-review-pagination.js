const assert = require('assert');
const MarianaTek = require('./providers/marianatek');
(async () => {
  const p = new MarianaTek({ id: 'fixture', apiBaseUrl: 'https://fixture.invalid/api/customer/v1', allowedRegionIds: ['uk'] });
  p._reservationClassEvents = async () => new Map();
  p.mapClassToEvent = c => ({ gymId: 'fixture', eventId: c.id, startAt: '2030-01-01T12:00:00Z' });
  const session = { accessToken: 'mock' };
  const cls = (id, region) => ({ id, location: { region: { id: region } } });
  p.request = async path => ({ ok: true, json: async () => path.includes('page=2')
    ? { results: [{ id: 'uk-booking', reservation_type: 'standard', class_session: cls('2', 'uk') }, { id: 'uk-wait', reservation_type: 'waitlist', class_session: cls('3', 'uk') }], next: null }
    : { results: [{ id: 'us', reservation_type: 'standard', class_session: cls('1', 'us') }], next: '?is_upcoming=true&page_size=100&page=2' } });
  p.cancelBooking = async id => id === 'uk-wait';
  assert.deepStrictEqual((await p.listBookings(session)).map(x => x.bookingId), ['uk-booking']);
  assert.deepStrictEqual((await p.listWaitlists(session)).map(x => x.bookingId), ['uk-wait']);
  assert.strictEqual(await p.leaveWaitlist('3', session), true);
  for (const next of ['https://evil.invalid/api/customer/v1/me/reservations?is_upcoming=true', 'https://fixture.invalid/api/customer/v1/me/profile?is_upcoming=true', 'https://fixture.invalid/api/customer/v1/me/reservations?is_upcoming=false']) {
    p.request = async () => ({ ok: true, json: async () => ({ results: [], next }) });
    await assert.rejects(() => p.listBookings(session), /pagination|reservation|invalid|unsafe/i);
  }
  console.log('Reservation pagination, waitlist lookup and URL boundaries passed');
})().catch(err => { console.error(err.message); process.exitCode = 1; });
