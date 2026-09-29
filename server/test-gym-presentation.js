// F-7 Stage A: per-gym presentation contract — validation + GET /api/gyms output.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
const assert = require('assert');
const express = require('express');
const { GYMS, validatePresentation } = require('./gyms.config');

const clone = (o) => JSON.parse(JSON.stringify(o));
const good = () => clone(GYMS['psycle-london'].presentation);
const checks = [];
const check = (n, f) => checks.push({ n, f });

check('every configured gym has a valid presentation', () => {
  for (const g of Object.values(GYMS)) assert.doesNotThrow(() => validatePresentation(g.presentation, g.id));
});

check('validator throws on malformed contracts', () => {
  const muts = [
    (p) => { delete p.shortName; },
    (p) => { p.wordmark.text = ''; },
    (p) => { p.wordmark.full.src = 'https://evil.example/x.svg'; },
    (p) => { p.plate = 'red'; },
    (p) => { delete p.dark; },
    (p) => { p.light.on = '#fff'; },
    (p) => { p.displayAliases = { bogus: {} }; },
    (p) => { p.displayAliases = { studios: { 'Recovery 2.0': 'Recovery' } }; },
    (p) => { p.displayAliases = { studios: { x: '' } }; },
  ];
  muts.forEach((m, i) => { const p = good(); m(p); assert.throws(() => validatePresentation(p, 't'), /presentation/, `mutation ${i}`); });
  assert.throws(() => validatePresentation(undefined, 't'));
});

check('JAB alias is scoped to JAB, Psycle has none', () => {
  assert.strictEqual(GYMS['jab-boxing'].presentation.displayAliases.studios['recovery 2.0'], 'Recovery');
  assert.deepStrictEqual(GYMS['psycle-london'].presentation.displayAliases, {});
});

check('GET /api/gyms returns presentation for every gym', async () => {
  const router = require('./routes-normalized');
  const app = express();
  app.use('/api', router.router || router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/gyms`);
    const { gyms } = await res.json();
    assert.strictEqual(gyms.length, Object.keys(GYMS).length);
    for (const g of gyms) assert.deepStrictEqual(g.presentation, GYMS[g.id].presentation);
  } finally { server.close(); }
});

(async () => {
  let failed = 0;
  for (const { n, f } of checks) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { failed++; console.log(`  ✗ ${n}\n      ${e.message}`); }
  }
  if (failed) { console.error(`✗ ${failed} presentation checks FAILED.`); process.exit(1); }
  console.log(`🎉 ${checks.length} presentation checks passed.`);
  process.exit(0);
})();
