// The product name comes from ONE place: server/config.js (APP_NAME). This boots
// the real server in production mode with a custom APP_NAME against the REAL
// client shell files (client/index.html, manifest.json, sw.js) and server/admin.html,
// and proves the name propagates to /api/config, the HTML, the manifest, the
// service worker, the admin page, the calendar feed and the generic push payload,
// and that the default product name appears in none of them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const NAME = 'Test Gym App';
const TRICKY = `Tom's "A&B" <Gym>`;
const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-name-'));
const pub = path.join(tmp, 'public');
fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'client', 'index.html'), path.join(pub, 'index.html'));
fs.copyFileSync(path.join(REPO, 'client', 'public', 'manifest.json'), path.join(pub, 'manifest.json'));
fs.copyFileSync(path.join(REPO, 'client', 'public', 'sw.js'), path.join(pub, 'sw.js'));

const ENV = {
  ...process.env,
  NODE_ENV: 'production',
  DB_PATH: ':memory:',
  PUBLIC_DIR: pub,
  JWT_SECRET: 'test-app-name-jwt',
  ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ADMIN_PASSWORD: 'test-admin-password',
  PUBLIC_HOST: 'app.test.example',
  VAPID_EMAIL: 'mailto:test@example.com',
};

async function withServer(port, appName, fn) {
  const child = spawn('node', ['server.js'], { cwd: __dirname, env: { ...ENV, PORT: String(port), APP_NAME: appName }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', () => {});
  try {
    const t0 = Date.now();
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/config`)).ok) break; } catch (_) { /* not up */ }
      if (Date.now() - t0 > 12000) throw new Error('server did not start: ' + err);
      await new Promise((r) => setTimeout(r, 150));
    }
    await fn(async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { r, text: await r.text() }; });
  } finally { child.kill(); }
}

async function run() {
  await withServer(3097, NAME, async (get) => {
    const cfg = JSON.parse((await get('/api/config')).text);
    assert.strictEqual(cfg.appName, NAME, '/api/config carries the configured name');
    const surfaces = { 'index.html': (await get('/')).text, 'manifest.json': (await get('/manifest.json')).text, 'sw.js': (await get('/sw.js')).text, admin: (await get('/admin')).text };
    for (const [k, text] of Object.entries(surfaces)) {
      assert.ok(text.includes(NAME), `${k} contains the configured name`);
      assert.ok(!/sweat/i.test(text), `${k} contains no 'Sweat'`);
      assert.ok(!text.includes('__APP_NAME__'), `${k} has no unreplaced placeholder`);
    }
    assert.ok(/<title>Test Gym App<\/title>/.test(surfaces['index.html']), 'index.html <title> is the configured name');
    assert.ok(/apple-mobile-web-app-title" content="Test Gym App"/.test(surfaces['index.html']));
    const manifest = JSON.parse(surfaces['manifest.json']);
    assert.strictEqual(manifest.name, NAME);
    assert.strictEqual(manifest.short_name, NAME);
    console.log('PASS configured name reaches /api/config, index.html, manifest, sw.js, admin');
  });

  await withServer(3096, TRICKY, async (get) => {
    const manifest = JSON.parse((await get('/manifest.json')).text);
    assert.strictEqual(manifest.name, TRICKY, 'manifest JSON-escapes the name');
    const sw = (await get('/sw.js')).text;
    assert.doesNotThrow(() => new Function(sw), 'sw.js stays valid JavaScript with a quote in the name');
    const html = (await get('/')).text;
    assert.ok(html.includes('Tom&#39;s &quot;A&amp;B&quot; &lt;Gym&gt;'), 'index.html HTML-escapes the name');
    assert.ok(!html.includes('<Gym>'), 'no raw markup injected');
    console.log('PASS awkward names are escaped per file type');
  });

  // Calendar feed + generic push payload, in a child so APP_NAME is read at require time.
  const probe = `
    const pushPath = require.resolve('web-push');
    const sent = [];
    require.cache[pushPath] = { id: pushPath, filename: pushPath, loaded: true, exports: {
      generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }), setVapidDetails() {},
      sendNotification: async (sub, payload) => { sent.push(JSON.parse(payload)); },
    } };
    const cal = require('./calendar');
    const ics = cal.serializeCalendar(1, [], {}, [], []);
    const db = require('./db');
    const uid = require('./testkit').createUser(db, "push@test.local", "enc:pw");
    db.addPushSubscription(uid, { endpoint: 'https://push.example/1', keys: {} });
    require('./notifications').sendGenericTest(uid).then(() => console.log(JSON.stringify({ ics, sent })));
  `;
  const out = spawnSync('node', ['-e', probe], { cwd: __dirname, env: { ...ENV, NODE_ENV: 'test', APP_NAME: NAME }, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, 'probe ran: ' + out.stderr);
  const { ics, sent } = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.ok(ics.includes(`PRODID:-//${NAME}//`) && ics.includes(`X-WR-CALNAME:${NAME}`), 'calendar PRODID / X-WR-CALNAME carry the name');
  assert.ok(!/sweat/i.test(ics), 'calendar output has no Sweat');
  assert.strictEqual(sent.length, 1, 'one push sent');
  assert.ok(sent[0].notification.title.includes(NAME) && sent[0].notification.body.includes(NAME), 'push title and body carry the name');
  assert.ok(!/sweat/i.test(JSON.stringify(sent)), 'push payload has no Sweat');
  console.log('PASS calendar feed and push payload carry the configured name');
}

run().then(() => { fs.rmSync(tmp, { recursive: true, force: true }); console.log('\n🎉 app-name config test PASSED.'); process.exit(0); })
  .catch((e) => { fs.rmSync(tmp, { recursive: true, force: true }); console.error('\n❌ FAILED:', e); process.exit(1); });
