// C2-4 — Psycle timetable = ranged v2 /events calls (no /locations fan-out, no per-location calls).
// LIVE FINDING (2026-10-06): an unscoped range 502s from ~14 days, so windows are chunked at 7 days.
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

check('42-day window = 6 ranged /events requests of <=7 days each (no /locations, no per-location calls)', async () => {
  const { result, calls } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(41) }, session));
  assert.strictEqual(calls.length, 6, `expected 6 upstream calls, got ${calls.length}: ${calls.map((c) => c.p).join(' | ')}`);
  assert.ok(calls.every((c) => /^\/events\?filter\[between\]=/.test(c.p) && !c.p.includes('location')), calls.map((c) => c.p).join(' | '));
  assert.ok(result.length > 0);
  assert.ok(result.every((e) => e.locationName && e.discipline), 'by-reference relations resolved');
});

check('range is honoured: a 3-day window returns only those days', async () => {
  const { result } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(2) }, session));
  const days = new Set(result.map((e) => e.startAt.slice(0, 10)));
  assert.ok(days.size <= 3 && days.size >= 1, [...days].join());
});

check('a 60-day window chunks to 9 calls, no duplicates', async () => {
  const { result, calls } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(60) }, session));
  assert.strictEqual(calls.length, 9, calls.map((c) => c.p).join(' | '));
  assert.strictEqual(new Set(result.map((e) => e.id)).size, result.length);
});

check('no single request spans more than 7 days (live unscoped 14d => 502)', async () => {
  const { calls } = await record(() => provider.fetchTimetable({ startDate: day(0), endDate: day(41) }, session));
  for (const c of calls) {
    const [a, b] = /between\]=([^,&]+),([^&]+)/.exec(c.p).slice(1);
    assert.ok((Date.parse(b) - Date.parse(a)) / 864e5 <= 7, c.p);
  }
});

(async () => {
  let pass = 0;
  for (const c of checks) {
    try { await c.fn(); pass++; console.log(`  ok  ${c.name}`); }
    catch (e) { console.error(`  FAIL ${c.name}\n       ${e.message}`); process.exitCode = 1; }
  }
  console.log(`${pass}/${checks.length} passed`);
})();
