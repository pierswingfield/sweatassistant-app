// Co-teach instructor records ("Brittney Tam & Geoff") are missing from the
// paged GET /instructors list; the photo must travel on the event itself.
const assert = require('assert');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
const { getProvider } = require('./providers');

const p = getProvider('psycle-london');
const raw = { id: 1, start_at: '2026-10-11T13:30:00', duration: 45, studio_id: 1, instructor_id: 576 };
const rel = { instructors: [{ id: 576, full_name: 'Brittney Tam & Geoff', photo: 'https://x/y.png' }] };
const e = p.mapEventToNormalized(p.resolveEventRelations(raw, rel));
assert.strictEqual(e.instructors[0].name, 'Brittney Tam & Geoff');
assert.ok(e.instructors[0].imageUrl.includes('/instructor-photo/psycle-london/576'));
const none = p.mapEventToNormalized({ ...raw, instructor: { id: 2, full_name: 'A' } });
assert.strictEqual(none.instructors[0].imageUrl, undefined);
console.log('1/1 instructor photo checks passed.');
(async () => {
  p.publicRequest = async () => ({ ok: true, json: async () => ({ data: [] }) });
  const r = await p.findInstructorPhoto(576);
  assert.strictEqual(r.imageUrl, 'https://x/y.png');
  console.log('photo lookup falls back to event-seen photo.');
})();
