// C2-4 — MarianaTek shared, single-flight, bounded, parallel class-list fetch.
// Platform-level (JAB and Aarmy share the adapter). Stubs the HTTP seam, no network.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const assert = require('assert');
const { getProvider } = require('./providers');
const MarianaTekProvider = require('./providers/marianatek');
const { isGymRateLimited, _resetRateLimitBackoffForTests } = require('./rate-limit-backoff');

const TOTAL_PAGES = 8;
const PAGE_MS = 40;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const cls = (n) => ({ id: String(n), name: `C${n}`, start_date: '2026-10-10', start_time: '09:00:00', start_datetime: '2026-10-10T09:00:00Z', capacity: 20,
  class_type: { name: 'Boxing', duration: 45 }, classroom: { id: 'r1', name: 'Room 1' }, instructors: [{ id: `i${n}`, name: `Inst ${n}` }] });
const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

// Returns {calls, maxInFlight, restore}. failPage / status override one page.
function stubUpstream({ failPage, failStatus = 500 } = {}) {
  const calls = []; let inFlight = 0; let maxInFlight = 0;
  const proto = MarianaTekProvider.prototype;
  const orig = { request: proto.request, publicRequest: proto.publicRequest };
  const impl = async function (path) {
    calls.push(path);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, PAGE_MS));
    inFlight--;
    const q = new URLSearchParams(path.split('?')[1] || '');
    const page = Number(q.get('page') || 1);
    if (failPage === page) return fakeRes(failStatus, {});
    return fakeRes(200, { results: [cls(page * 2), cls(page * 2 + 1)],
      meta: { pagination: { page, pages: TOTAL_PAGES, count: TOTAL_PAGES * 2, per_page: 2 } },
      next: page < TOTAL_PAGES ? `https://x.example/api/customer/v1/classes?page=${page + 1}` : null });
  };
  proto.request = impl; proto.publicRequest = impl;
  return { calls, get maxInFlight() { return maxInFlight; }, restore() { Object.assign(proto, orig); } };
}
const fresh = (id = 'jab-boxing') => { const p = getProvider(id); p._classFlights && p._classFlights.clear(); return p; };
const S = { accessToken: 'tok' };
const W = { startDate: '2026-10-05', endDate: '2026-11-01' };

check('(a) timetable + metadata requested concurrently share ONE upstream class-list fetch', async () => {
  const up = stubUpstream(); const p = fresh();
  try {
    const [events, meta] = await Promise.all([p.fetchTimetable(W, S), p.fetchMetadata(W, S)]);
    assert.strictEqual(up.calls.length, TOTAL_PAGES, `expected ${TOTAL_PAGES} upstream pages, got ${up.calls.length}`);
    assert.strictEqual(events.length, TOTAL_PAGES * 2);
    assert.ok(meta.instructors.length === TOTAL_PAGES * 2, 'metadata derived from the same list');
  } finally { up.restore(); }
});

check('(a2) metadata with no dates joins an in-flight timetable fetch that covers its default window', async () => {
  const up = stubUpstream(); const p = fresh();
  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  try {
    await Promise.all([p.fetchTimetable({ startDate: d(0), endDate: d(28) }, S), p.fetchMetadata({}, S)]);
    assert.strictEqual(up.calls.length, TOTAL_PAGES, `got ${up.calls.length} upstream calls`);
  } finally { up.restore(); }
});

check('(b) pages 2..N are fetched concurrently, bounded by the cap', async () => {
  const up = stubUpstream(); const p = fresh();
  try {
    const t0 = Date.now();
    await p.fetchTimetable(W, S);
    const ms = Date.now() - t0;
    assert.ok(up.maxInFlight > 1, 'pages ran concurrently');
    assert.ok(up.maxInFlight <= MarianaTekProvider.CLASS_LIST_PAGE_CONCURRENCY, `in-flight ${up.maxInFlight} exceeds cap`);
    assert.ok(ms < PAGE_MS * TOTAL_PAGES * 0.8, `took ${ms}ms, looks serial`);
  } finally { up.restore(); }
});

check('(c) a failed page fails the whole fetch and nothing partial is returned', async () => {
  const up = stubUpstream({ failPage: 5 }); const p = fresh();
  try {
    await assert.rejects(() => p.fetchTimetable(W, S), /fetchTimetable failed: 500/);
    await assert.rejects(() => p.fetchMetadata(W, S), /failed: 500/);
    assert.strictEqual(p._classFlights.size, 0, 'failed flights are not retained as results');
  } finally { up.restore(); }
  const ok = stubUpstream(); // recovery: next call is a real full fetch, not a cached partial
  try { assert.strictEqual((await p.fetchTimetable(W, S)).length, TOTAL_PAGES * 2); } finally { ok.restore(); }
});

check('(c2) a 429 on any page aborts, arms the per-gym backoff and stops launching pages', async () => {
  _resetRateLimitBackoffForTests();
  const up = stubUpstream({ failPage: 2, failStatus: 429 }); const p = fresh();
  try {
    await assert.rejects(() => p.fetchTimetable(W, S), (e) => e.status === 429);
    assert.ok(isGymRateLimited('jab-boxing'), 'backoff armed for this gym');
    assert.ok(!isGymRateLimited('aarmy'), 'other gyms unaffected');
    assert.ok(up.calls.length < TOTAL_PAGES, `pages after the 429 were not all launched (${up.calls.length})`);
  } finally { up.restore(); _resetRateLimitBackoffForTests(); }
});

check('(c3) exceeding the page safety cap throws instead of truncating', async () => {
  const proto = MarianaTekProvider.prototype; const orig = proto.publicRequest; const origReq = proto.request;
  const impl = async () => fakeRes(200, { results: [cls(1)], meta: { pagination: { page: 1, pages: 9999, count: 9999 } } });
  proto.publicRequest = impl; proto.request = impl;
  try { await assert.rejects(() => fresh().fetchTimetable(W, S), /too many pages|exceeds/i); }
  finally { proto.publicRequest = orig; proto.request = origReq; }
});

check('(d) metadata without dates requests a bounded window, never an open-ended one', async () => {
  const up = stubUpstream(); const p = fresh();
  try {
    await p.fetchMetadata({}, S);
    assert.ok(up.calls.length > 0);
    for (const c of up.calls) {
      const q = new URLSearchParams(c.split('?')[1]);
      assert.ok(q.get('min_start_date') && q.get('max_start_date'), `unbounded request: ${c}`);
      const span = (Date.parse(q.get('max_start_date')) - Date.parse(q.get('min_start_date'))) / 864e5;
      assert.ok(span <= 28, `window ${span}d too wide`);
    }
  } finally { up.restore(); }
});

check('serial fallback: a payload without page count still follows next links', async () => {
  const proto = MarianaTekProvider.prototype; const orig = proto.publicRequest; const origReq = proto.request;
  const impl = async (path) => {
    const page = Number(new URLSearchParams(path.split('?')[1]).get('page') || 1);
    return fakeRes(200, { results: [cls(page)], links: { next: page < 3 ? `https://x.example/api/customer/v1/classes?page=${page + 1}` : null } });
  };
  proto.publicRequest = impl; proto.request = impl;
  try { assert.strictEqual((await fresh().fetchTimetable(W)).length, 3); }
  finally { proto.publicRequest = orig; proto.request = origReq; }
});

(async () => {
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); } catch (e) { failed++; console.error(`❌ ${name}\n   ${e.message}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} class-list checks passed.`);
  process.exit(failed ? 1 : 0);
})();
