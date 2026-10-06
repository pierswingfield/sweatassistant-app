// C2-4 — Psycle timetable = ONE ranged v2 /events call (cap 42 days), not /locations + one call per location.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const assert = require('assert');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');
const provider = getProvider('psycle-london');

const session = { accessToken: 'mock-jwt-token' };
async function record(fn) {
  const calls = [];
  const mkStub = (kind) => async function (p, opts) {
    calls.push({ kind, p });
    return CodexFitProvider.prototype.__orig[kind].call(this, p, opts);
  };
  CodexFitProvider.prototype.__orig = { request: CodexFitProvider.prototype.request, requestV2: CodexFitProvider.prototype.requestV2, publicRequest: CodexFitProvider.prototype.publicRequest };
  CodexFitProvider.prototype.request = mkStub('request');
  CodexFitProvider.prototype.requestV2 = mkStub('requestV2');
  CodexFitProvider.prototype.publicRequest = mkStub('publicRequest');
  const log = console.log; console.log = () => {};
  try { return { result: await fn(), calls }; } finally {
    console.log = log;
    Object.assign(CodexFitProvider.prototype, CodexFitProvider.prototype.__orig);
  }
}
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('42-day window is exactly ONE upstream /events request (no /locations fan-out)', async () => {
  const { result, calls } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(41) }, session));
  assert.strictEqual(calls.length, 1, `expected 1 upstream call, got ${calls.length}: ${calls.map((c) => c.p).join(' | ')}`);
  assert.ok(/^\/events\?/.test(calls[0].p) && calls[0].p.includes('filter[between]='), calls[0].p);
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.locationName && e.discipline), 'by-reference relations resolved');
});

check('range is honoured: a 3-day window returns only those days', async () => {
  const { result } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(2) }, session));
  const days = new Set(result.map((e) => e.startAt.slice(0, 10)));
  assert.ok(days.size <= 3 && days.size >= 1, [...days].join());
});

check('window beyond 42 days is chunked (2 calls for 43..84 days), no duplicates', async () => {
  const { result, calls } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(60) }, session));
  assert.strictEqual(calls.length, 2, calls.map((c) => c.p).join(' | '));
  assert.strictEqual(new Set(result.map((e) => e.id)).size, result.length);
});

(async () => {
  let pass = 0;
  for (const c of checks) {
    try { await c.fn(); pass++; console.log(`  ok  ${c.name}`); }
    catch (e) { console.error(`  FAIL ${c.name}\n       ${e.message}`); process.exitCode = 1; }
  }
  console.log(`${pass}/${checks.length} passed`);
})();
