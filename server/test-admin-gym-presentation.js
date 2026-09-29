// F-7 Stage B: admin presentation editor — auth, validation, persistence,
// reset, and a connection test that is provably read-only.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.ADMIN_PASSWORD = 'pw-test';
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const gymsConfig = require('./gyms.config');
const { getProvider } = require('./providers');
const adminRouter = require('./admin');

const clone = (o) => JSON.parse(JSON.stringify(o));
const checks = [];
const check = (n, f) => checks.push({ n, f });
let base; let token;
const call = async (method, p, body, auth = true) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};
const GID = 'jab-boxing';
const P = '/api/admin/gym-presentations';

check('routes require the admin JWT', async () => {
  for (const [m, p] of [['GET', P], ['PUT', `${P}/${GID}`], ['DELETE', `${P}/${GID}`], ['POST', `${P}/${GID}/test-connection`], ['POST', `${P}/${GID}/validate`]]) {
    const r = await call(m, p, m === 'GET' ? undefined : {}, false);
    assert.strictEqual(r.status, 401, `${m} ${p}`);
  }
});

check('list returns presentation and never headers or credentials', async () => {
  const r = await call('GET', P);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.gyms.length, Object.keys(gymsConfig.GYMS).length);
  const txt = JSON.stringify(r.data);
  assert(!/x-organisation|user-agent|apiBaseUrl|password|token/i.test(txt), 'no protocol/secret fields');
});

check('invalid contract is rejected and not persisted', async () => {
  const p = clone(gymsConfig.GYMS[GID].presentation); p.plate = 'red';
  assert.strictEqual((await call('POST', `${P}/${GID}/validate`, { presentation: p })).status, 400);
  assert.strictEqual((await call('PUT', `${P}/${GID}`, { presentation: p })).status, 400);
  assert.deepStrictEqual(db.readPresentationOverrides(), {});
  assert.strictEqual((await call('PUT', `${P}/nope`, { presentation: p })).status, 404);
});

check('valid edit persists, applies live, whitelists keys and survives re-apply', async () => {
  const p = clone(gymsConfig.GYMS[GID].presentation); p.shortName = 'JAB2'; p.evil = 'x'; p.protocol = { apiBaseUrl: 'http://x' };
  const baselineUrl = gymsConfig.GYMS[GID].apiBaseUrl;
  const r = await call('PUT', `${P}/${GID}`, { presentation: p });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.overridden, true);
  assert.strictEqual(gymsConfig.GYMS[GID].presentation.shortName, 'JAB2');
  assert.strictEqual(gymsConfig.GYMS[GID].presentation.evil, undefined);
  assert.strictEqual(gymsConfig.GYMS[GID].apiBaseUrl, baselineUrl, 'protocol untouched');
  assert.strictEqual(db.readPresentationOverrides()[GID].shortName, 'JAB2');
  // simulate reboot: registry back to baseline, then overrides re-applied
  gymsConfig.resetPresentation(GID);
  assert.notStrictEqual(gymsConfig.GYMS[GID].presentation.shortName, 'JAB2');
  db.applyPresentationOverrides();
  assert.strictEqual(gymsConfig.GYMS[GID].presentation.shortName, 'JAB2');
  // and the public catalogue serves it
  const router = require('./routes-normalized');
  const app = express(); app.use('/api', router.router || router);
  const s = await new Promise((rs) => { const x = app.listen(0, '127.0.0.1', () => rs(x)); });
  try {
    const { gyms } = await (await fetch(`http://127.0.0.1:${s.address().port}/api/gyms`)).json();
    assert.strictEqual(gyms.find((g) => g.id === GID).presentation.shortName, 'JAB2');
  } finally { s.close(); }
});

check('a corrupt stored override is skipped at boot, registry value kept', () => {
  db.writePresentationOverrides({ [GID]: { shortName: '' }, ghost: {} });
  gymsConfig.resetPresentation(GID);
  db.applyPresentationOverrides();
  assert.strictEqual(gymsConfig.GYMS[GID].presentation.shortName, gymsConfig.getBaselinePresentation(GID).shortName);
});

check('reset restores registry values and clears the override', async () => {
  const p = clone(gymsConfig.GYMS[GID].presentation); p.shortName = 'Tmp';
  await call('PUT', `${P}/${GID}`, { presentation: p });
  const r = await call('DELETE', `${P}/${GID}`);
  assert.strictEqual(r.data.overridden, false);
  assert.deepStrictEqual(r.data.presentation, gymsConfig.getBaselinePresentation(GID));
  assert.strictEqual(db.readPresentationOverrides()[GID], undefined);
});

check('test-connection is read-only: only fetchMetadata (no session) is called', async () => {
  const prov = getProvider(GID);
  const calls = [];
  const orig = {};
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(prov)).concat(Object.getOwnPropertyNames(prov))) {
    if (name === 'constructor' || typeof prov[name] !== 'function') continue;
    orig[name] = prov[name];
    prov[name] = (...a) => { calls.push({ name, a }); return name === 'fetchMetadata' ? Promise.resolve({ locations: [1], studios: [1, 2], instructors: [] }) : Promise.reject(new Error('unexpected ' + name)); };
  }
  try {
    const r = await call('POST', `${P}/${GID}/test-connection`);
    assert.deepStrictEqual(r.data.counts, { locations: 1, studios: 2, instructors: 0 });
    assert.strictEqual(r.data.ok, true);
    assert.deepStrictEqual(calls.map((c) => c.name), ['fetchMetadata']);
    assert.strictEqual(calls[0].a[1], null, 'no session passed');
    // failure is reported, not thrown
    prov.fetchMetadata = () => Promise.reject(Object.assign(new Error('boom'), { status: 503 }));
    const f = await call('POST', `${P}/${GID}/test-connection`);
    assert.strictEqual(f.status, 200); assert.strictEqual(f.data.ok, false); assert.strictEqual(f.data.status, 503);
  } finally { for (const [k, v] of Object.entries(orig)) prov[k] = v; delete prov.fetchMetadata; }
});

check('editor code names no gym id and admin.js has no booking calls in the test path', () => {
  const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  const editor = html.slice(html.indexOf('Gym presentation editor (F-7'));
  for (const id of Object.keys(gymsConfig.GYMS)) assert(!editor.includes(id), `editor names ${id}`);
  const src = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
  const block = src.slice(src.indexOf("'/gym-presentations/:gymId/test-connection'"));
  const end = block.indexOf('\n});');
  assert(!/book|cancel|login|swap|waitlist|POST|PUT/.test(block.slice(0, end).replace(/router\.post\([^,]+,/, '')));
});

(async () => {
  const app = express(); app.use(express.json()); app.use('/api/admin', adminRouter.router || adminRouter);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await call('POST', '/api/admin/login', { password: 'pw-test' }, false)).data.token;
  let failed = 0;
  for (const { n, f } of checks) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { failed++; console.log(`  ✗ ${n}\n      ${e.stack || e.message}`); }
  }
  server.close();
  if (failed) { console.error(`✗ ${failed} admin presentation checks FAILED.`); process.exit(1); }
  console.log(`🎉 ${checks.length} admin presentation checks passed.`);
  process.exit(0);
})();
