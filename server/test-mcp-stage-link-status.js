'use strict';

const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'fixture-jwt-secret-for-stage-route';
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.MCP_STAGE_JAB_PROFILE_ONLY = 'true';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');
const auth = require('./auth');
const testkit = require('./testkit');
const router = require('./routes-normalized');

async function main() {
  const email = 'mcp-stage-link-status@test.local';
  const userId = testkit.createUser(db, email, 'encrypted-fixture');
  const token = jwt.sign({ userId, email }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const original = auth.linkGymAccount;
  try {
    auth.linkGymAccount = async () => {
      throw Object.assign(new Error('restricted gateway temporarily busy'), { code: 'PROVIDER_WORK_DISABLED', status: 429 });
    };
    const url = `http://127.0.0.1:${server.address().port}/api/my-gyms/link`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gymId: 'jab-boxing', email: 'fixture@example.test', password: 'fixture-password' }),
    });
    assert.equal(response.status, 429, 'temporary broker capacity refusal must remain retryable, not become a bad-credentials 400');
    const body = await response.json();
    assert.equal(body.message, 'restricted gateway temporarily busy');

    auth.linkGymAccount = async () => {
      throw Object.assign(new Error('restricted gateway is unavailable'), { code: 'PROVIDER_WORK_DISABLED', status: 503 });
    };
    const gatewayUnavailable = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gymId: 'jab-boxing', email: 'fixture@example.test', password: 'fixture-password' }),
    });
    assert.equal(gatewayUnavailable.status, 503, 'gateway outages must remain distinguishable from bad credentials');

    auth.linkGymAccount = async () => { throw new Error('incorrect email/password'); };
    const badCredentials = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gymId: 'jab-boxing', email: 'fixture@example.test', password: 'wrong' }),
    });
    assert.equal(badCredentials.status, 400, 'actual credential rejection remains a client error');
    process.stdout.write('stage link route preserves gateway capacity status while keeping credential failures at 400\n');
  } finally {
    auth.linkGymAccount = original;
    await new Promise(resolve => server.close(resolve));
    db.db.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
