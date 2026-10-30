// Home attendance server seam: MarianaTek's fixture-backed achievements read.
//
// This suite deliberately tests the provider contract and gym-scoped route,
// including missing/failed upstream data. It never calls a live gym API.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-mariana-attendance-secret';

const assert = require('assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const testkit = require('./testkit');
const { getProvider } = require('./providers');
const { GYMS } = require('./gyms.config');

const JAB = 'jab-boxing';
const AARMY = 'aarmy';
const BARRYS = 'barrys-uk';
const fixture = require('./__fixtures__/marianatek/prod-achievements.json');
const barrysFixture = require('./__fixtures__/marianatek/barrys-achievements.json');
const expected = fixture.response_body.classes_completed;

db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id IN (?, ?)').run(JAB, AARMY);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('MarianaTek maps fixture classes_completed to official all-time attendance', async () => {
  const provider = getProvider(JAB);
  const totals = await provider.getMilestones({ accessToken: 'mock-mt-token' });
  assert.deepStrictEqual(totals, { attendedTotal: expected, milestones: [] });
});

check("Barry's maps the tenant-wide achievement total without region filtering", async () => {
  const provider = getProvider(BARRYS);
  const totals = await provider.getMilestones({ accessToken: 'mock-mt-token' });
  assert.deepStrictEqual(totals, { attendedTotal: barrysFixture.response_body.classes_completed, milestones: [] });
  assert.strictEqual(GYMS[BARRYS].capabilities.attendanceTotals, true);
  const mock = await provider.request('/me/achievements', { token: provider.mockToken });
  assert.strictEqual((await mock.json()).classes_completed, 612);
});

check('MarianaTek rejects missing attendance totals instead of turning them into zero', async () => {
  const provider = getProvider(JAB);
  const original = provider.request;
  provider.request = async () => ({ ok: true, status: 200, json: async () => ({ classes_completed: null, instructors_taken: 13 }) });
  try {
    await assert.rejects(
      () => provider.getMilestones({ accessToken: 'fixture-invalid' }),
      /no valid classes_completed attendance total/
    );
  } finally {
    provider.request = original;
  }
});

check('MarianaTek surfaces an upstream achievements failure', async () => {
  const provider = getProvider(JAB);
  const original = provider.request;
  provider.request = async () => ({ ok: false, status: 503, json: async () => ({}) });
  try {
    await assert.rejects(
      () => provider.getMilestones({ accessToken: 'fixture-error' }),
      /getMilestones failed: 503/
    );
  } finally {
    provider.request = original;
  }
});

check('attendance route is gym-scoped for both MarianaTek tenants', async () => {
  const router = require('./routes-normalized');
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const uid = testkit.createUser(db, `mariana-attendance-${Date.now()}@test.local`, 'enc:pw');
  try {
    for (const gymId of [JAB, AARMY]) {
      db.linkGym(uid, gymId, { encryptedPassword: 'enc:pw' });
      db.setGymSession(uid, gymId, { accessToken: 'mock-mt-token' });
    }
    const token = jwt.sign({ userId: uid, email: 'mariana-attendance@test.local' }, process.env.JWT_SECRET);
    for (const gymId of [JAB, AARMY]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/attendance-totals`, {
        headers: { authorization: `Bearer ${token}`, 'x-gym-id': gymId },
      });
      assert.strictEqual(res.status, 200, `${gymId} route status`);
      assert.deepStrictEqual(await res.json(), { gymId, attendedTotal: expected, milestones: [] });
    }
  } finally {
    db.deleteUser(uid);
    server.close();
  }
});

assert.strictEqual(GYMS[JAB].capabilities.attendanceTotals, true);
assert.strictEqual(GYMS[AARMY].capabilities.attendanceTotals, true);

(async () => {
  let passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
  }
  console.log(`${passed}/${checks.length} MarianaTek attendance checks passed`);
  process.exit(process.exitCode || 0);
})();
