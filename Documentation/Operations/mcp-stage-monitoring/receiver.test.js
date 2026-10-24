'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, MAX_BODY } = require('./receiver');
const TOKEN = 'test-only-token-'.padEnd(48, 'x');

async function withServer(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-stage-receiver-'));
  const server = createServer({ token: 'test-only-token-'.padEnd(48, 'x'), stateDir: dir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, dir };
}

test('rejects unauthenticated and unsupported requests without recording payloads', async (t) => {
  const { base, dir } = await withServer(t);
  const body = JSON.stringify({ status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'McpReadFailures' } }] });
  assert.equal((await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(`${base}/webhook`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, body })).status, 415);
  assert.equal(fs.existsSync(path.join(dir, 'aggregate-counts.json')), false);
});

test('bounds body size, rejects unknown alert names, and stores no alert payload', async (t) => {
  const { base, dir } = await withServer(t);
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const tooLarge = await fetch(`${base}/webhook`, { method: 'POST', headers, body: ' '.repeat(MAX_BODY + 1) });
  assert.equal(tooLarge.status, 413);
  const unknown = await fetch(`${base}/webhook`, { method: 'POST', headers, body: JSON.stringify({ status: 'firing', alerts: [{ status: 'firing', labels: { alertname: 'UnknownSecretLabel' }, annotations: { summary: 'private' } }] }) });
  assert.equal(unknown.status, 400);
  assert.equal(fs.existsSync(path.join(dir, 'aggregate-counts.json')), false);
});

test('persists fixed-label firing/resolved delivery counts only', async (t) => {
  const { base, dir } = await withServer(t);
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  for (const status of ['firing', 'resolved']) {
    const response = await fetch(`${base}/webhook`, { method: 'POST', headers, body: JSON.stringify({ status, alerts: [{ status, labels: { alertname: 'StageOpsSyntheticAcceptance', secret: 'must-not-persist' }, annotations: { summary: 'must-not-persist' } }] }) });
    assert.equal(response.status, 204);
  }
  const saved = fs.readFileSync(path.join(dir, 'aggregate-counts.json'), 'utf8');
  assert.match(saved, /StageOpsSyntheticAcceptance\/firing/);
  assert.match(saved, /StageOpsSyntheticAcceptance\/resolved/);
  assert.doesNotMatch(saved, /must-not-persist|secret|summary/);
  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /stage_ops_alert_webhook_deliveries_total\{alert="StageOpsSyntheticAcceptance",status="firing"\} 1/);
  assert.match(metrics, /stage_ops_filesystem_available_bytes/);
});
