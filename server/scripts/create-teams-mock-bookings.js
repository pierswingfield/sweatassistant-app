'use strict';
// Generate isolated, date-aligned CodexFit mock bookings for Teams UX checks.
// Run only against a local mock server, with MOCK_BOOKINGS_PATH set to a disposable file.
const fs = require('fs');
const path = require('path');
if (process.env.NODE_ENV !== 'development' || !process.env.MOCK_BOOKINGS_PATH || !path.isAbsolute(process.env.MOCK_BOOKINGS_PATH)) {
  throw new Error('Requires NODE_ENV=development and an absolute disposable MOCK_BOOKINGS_PATH.');
}
// Reserve the target before loading the mock, whose module initializes its file.
fs.writeFileSync(process.env.MOCK_BOOKINGS_PATH, '[]', { flag: 'wx' });
const { getProvider } = require('../providers');
(async () => {
  const provider = getProvider('psycle-london');
  if (!provider.gym.devMock || !provider.mockToken) throw new Error('The gym has no mock provider.');
  const now = Date.now();
  const start = new Date(now).toISOString().slice(0, 10);
  const end = new Date(now + 3 * 86400000).toISOString().slice(0, 10);
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('Outbound network forbidden while creating mock bookings.'); };
  try {
    const events = await provider.fetchTimetable({ startDate: start, endDate: end }, { accessToken: provider.mockToken });
    const candidates = events.filter((e) => Date.parse(e.startAt) > now && e.studioId === '138');
    const today = candidates.find((e) => Date.parse(e.startAt) - now < 12 * 3600000);
    const later = candidates.filter((e) => Date.parse(e.startAt) - now > 12 * 3600000);
    const selected = [...(today ? [today] : []), ...later].slice(0, 3);
    if (!selected.length || !later.length) throw new Error('No suitable upcoming mock classes.');
    const rows = selected.map((e, i) => ({ id: 8255401 + i, event_id: Number(e.id), booked_at: new Date(now - 3600000).toISOString(),
      studio_slot: { id: 23 + i, label: String(23 + i) }, event: { ...e.raw,
        studio: { id: Number(e.studioId), name: e.studioName, location: { id: Number(e.locationId), name: e.locationName } } } }));
    fs.writeFileSync(process.env.MOCK_BOOKINGS_PATH, JSON.stringify(rows, null, 2));
    console.log(`Created ${rows.length} current mock bookings in ${process.env.MOCK_BOOKINGS_PATH}.`);
  } finally { global.fetch = originalFetch; }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
