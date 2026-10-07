// C7-3 step 3 — /metrics (Prometheus text). Before: no metrics at all, only /api/health JSON.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const metrics = require('./metrics');
const { timedProviderFetch } = require('./logger');
const PORT = 3098;
const DB_PATH = path.join(__dirname, 'test-metrics.db');
const ADMIN_PASSWORD = 'scratch-admin-pw';
const METRICS_TOKEN = 'scratch-metrics-token';
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};

function get(port, path, token) {
  return new Promise((resolve, reject) => {
    http.get({ port, path, headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve({ status: res.statusCode, body: s, type: res.headers['content-type'] }));
    }).on('error', reject);
  });
}

(async () => {
  // Provider outcomes count regardless of LOG_LEVEL.
  await timedProviderFetch('psycle-london', 'GET', '/events?x=1', async () => ({ status: 200 }));
  await timedProviderFetch('psycle-london', 'GET', '/events', async () => ({ status: 429 }));
  await timedProviderFetch('jab-boxing', 'GET', '/x', async () => { throw new Error('net'); }).catch(() => {});

  const local = metrics.render();
  for (const n of [
    'provider_calls_total{gym="psycle-london",platform="codexfit",outcome="ok"} 1',
    'provider_calls_total{gym="psycle-london",platform="codexfit",outcome="429"} 1',
    'provider_calls_total{gym="jab-boxing",platform="marianatek",outcome="error"} 1',
  ]) assert.ok(local.includes(n), `missing: ${n}`);

  cleanup();
  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ADMIN_PASSWORD, METRICS_TOKEN } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const port = PORT;
  try {
    assert.strictEqual((await get(port, '/metrics')).status, 401, 'unauthenticated must be refused');
    assert.strictEqual((await get(port, '/metrics', 'wrong')).status, 403);
    await get(port, '/api/gyms');
    await get(port, '/api/nope-1234');
    const ok = await get(port, '/metrics', METRICS_TOKEN);
    assert.strictEqual(ok.status, 200);
    assert.ok(/^text\/plain/.test(ok.type), ok.type);
    const b = ok.body;
    // valid exposition lines
    for (const l of b.split('\n').filter(Boolean)) {
      assert.ok(/^# (HELP|TYPE) \w+ .+$/.test(l) || /^[a-zA-Z_:][\w:]*(\{[^}]*\})? -?[\d.eE+]+(Inf)?$/.test(l), `bad line: ${l}`);
    }
    for (const needle of [
      'http_requests_total{route="/api/gyms",status_class="2xx"}',
      'http_request_duration_seconds_count{route="/api/gyms"}',
      '# TYPE provider_calls_total counter',
      'schedule_cache_events_total{result="miss"}', 'schedule_cache_events_total{result="hit"}', 'schedule_cache_events_total{result="stale"}',
      'scheduler_pending_bookings ', 'scheduler_next_release_timestamp_seconds ',
      'service_heartbeat_age_seconds{service="poller"}',
      'rate_limit_backoff_active{gym="psycle-london"}',
      'process_uptime_seconds ', 'process_resident_memory_bytes ',
    ]) assert.ok(b.includes(needle), `missing: ${needle}`);
    assert.ok(!b.includes('nope-1234'), 'raw path leaked as label');
    assert.ok(b.includes('route="unmatched"'));
    assert.ok(!/user|email|token|password/i.test(b.replace(/# (HELP|TYPE).*/g, '')), 'identifier-like label');
    // admin JWT also accepted
    const login = await new Promise((resolve) => {
      const r = http.request({ port, method: 'POST', path: '/api/admin/login', headers: { 'content-type': 'application/json' } }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve(JSON.parse(s))); });
      r.end(JSON.stringify({ password: ADMIN_PASSWORD }));
    });
    assert.strictEqual((await get(port, '/metrics', login.token)).status, 200);
    console.log('test-metrics: all checks passed');
  } catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
  finally { cleanup(); process.exit(process.exitCode || 0); }
})();
