// U4-19 phase 2: SPA fallback allowlist. Boots the real server in PRODUCTION mode
// against a fixture build dir (PUBLIC_DIR) and asserts each path class:
// app paths -> index.html; /api/* unknown -> JSON 404 (never HTML); real API,
// .ics, /admin, /sw.js, /manifest.json, /assets/*, /gyms/* keep working;
// everything else -> 404, not the shell.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-fallback-'));
const pub = path.join(tmp, 'public');
fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });
fs.mkdirSync(path.join(pub, 'gyms'), { recursive: true });
fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>SHELL</title><script type="module" src="/assets/app.js"></script>');
fs.writeFileSync(path.join(pub, 'manifest.json'), '{"name":"__APP_NAME__","start_url":"/"}');
fs.writeFileSync(path.join(pub, 'sw.js'), '// sw');
fs.writeFileSync(path.join(pub, 'assets', 'app.js'), 'console.log(1)');
fs.writeFileSync(path.join(pub, 'gyms', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');

let child;
const cleanup = () => { try { child && child.kill(); } catch (_) { /* gone */ } fs.rmSync(tmp, { recursive: true, force: true }); };

async function get(p, opts = {}) {
  const res = await fetch(BASE + p, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { res, text, type: res.headers.get('content-type') || '' };
}
const isShell = (r) => r.res.status === 200 && r.text.includes('<title>SHELL</title>') && /text\/html/.test(r.type);

async function run() {
  child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      DB_PATH: ':memory:',
      PUBLIC_DIR: pub,
      JWT_SECRET: 'test-spa-fallback-jwt',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ADMIN_PASSWORD: 'test-admin-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', () => {});

  const start = Date.now();
  for (;;) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) { /* not up */ }
    if (Date.now() - start > 12000) throw new Error('server did not start: ' + err);
    await new Promise((r) => setTimeout(r, 150));
  }

  // App paths -> shell (including deep settings sections, trailing slash, query).
  for (const p of ['/', '/index.html', '/timetable', '/timetable?day=2026-10-07&gym=jab', '/bookings', '/auto-book',
    '/credits', '/settings', '/settings/about', '/settings/gym-jab-boxing', '/settings/', '/Timetable']) {
    assert.ok(isShell(await get(p)), `${p} should serve the SPA shell`);
  }
  console.log('PASS app paths serve the shell');

  // Unknown /api/* -> JSON 404, never HTML.
  for (const p of ['/api/nope', '/api/timetable/does/not/exist', '/api/settings/x/y', '/api/']) {
    const r = await get(p);
    assert.ok([404, 401].includes(r.res.status), `${p} status ${r.res.status}`);
    assert.ok(/application\/json/.test(r.type), `${p} should be JSON, got ${r.type}`);
    assert.ok(!r.text.includes('SHELL'), `${p} must not return the shell`);
  }
  const nf = await get('/api/definitely-not-a-route');
  assert.strictEqual(nf.res.status, 404);
  assert.strictEqual(JSON.parse(nf.text).code, 'NOT_FOUND');
  const post = await get('/api/definitely-not-a-route', { method: 'POST' });
  assert.strictEqual(post.res.status, 404);
  assert.ok(/json/.test(post.type));
  console.log('PASS unknown /api/* is JSON 404');

  // Real routes survive.
  const health = await get('/api/health');
  assert.ok(/json/.test(health.type) && !health.text.includes('SHELL'), '/api/health stays an API route');
  const cfg = await get('/api/config');
  assert.strictEqual(cfg.res.status, 200);
  const ics = await get('/api/calendar/not-a-real-token.ics');
  assert.ok(ics.res.status !== 200 || !ics.text.includes('SHELL'));
  assert.ok(!ics.text.includes('SHELL'), '.ics route must not fall to the shell');
  assert.ok(ics.res.status >= 400, `.ics bad token should not be 200, got ${ics.res.status}`);
  const admin = await get('/admin');
  assert.strictEqual(admin.res.status, 200);
  assert.ok(!admin.text.includes('SHELL'), '/admin is its own page');
  console.log('PASS /api, .ics and /admin unaffected');

  // Static files.
  assert.strictEqual((await get('/sw.js')).text.trim(), '// sw');
  assert.ok(/manifest\+json/.test((await get('/manifest.json')).type));
  const asset = await get('/assets/app.js');
  assert.strictEqual(asset.text, 'console.log(1)');
  assert.ok(/javascript/.test(asset.type));
  assert.strictEqual((await get('/gyms/x.svg')).res.status, 200);
  assert.strictEqual((await get('/assets/missing.js')).res.status, 404);
  console.log('PASS static assets, sw.js, manifest, gyms');

  // Non-app paths are a real 404, not the shell.
  for (const p of ['/nope', '/timetable/extra', '/settings/a/b', '/settings/%3Cscript%3E', '/.env', '/server.js']) {
    const r = await get(p);
    assert.strictEqual(r.res.status, 404, `${p} should 404, got ${r.res.status}`);
    assert.ok(!r.text.includes('SHELL'), `${p} must not return the shell`);
  }
  console.log('PASS non-app paths 404');

  // Built asset URLs must be root-absolute so nested paths (/settings/gym-x) resolve them.
  const shell = (await get('/settings/gym-jab')).text;
  assert.ok(!/(?:src|href)="(?!\/|https?:|#|data:)/.test(shell), 'shell uses root-absolute asset URLs');
  console.log('PASS asset URLs root-absolute');

  // A rebuilt client must be served without restarting the server (templated index.html was cached for the process lifetime).
  const indexPath = path.join(pub, 'index.html');
  const rebuilt = '<!doctype html><title>SHELL</title><script type="module" src="/assets/app.REBUILT.js"></script>';
  fs.writeFileSync(indexPath, rebuilt);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(indexPath, future, future); // guarantee a distinct mtime on coarse-mtime filesystems
  const after = await get('/');
  assert.ok(after.text.includes('app.REBUILT.js'), 'rebuilt index.html is served without a restart');
  const afterDeep = await get('/timetable');
  assert.ok(afterDeep.text.includes('app.REBUILT.js'), 'same for SPA fallback paths');
  console.log('PASS rebuilt index.html served without restart');
}

run().then(() => { cleanup(); console.log('spa-fallback: all checks passed'); process.exit(0); })
  .catch((e) => { cleanup(); console.error(e); process.exit(1); });
