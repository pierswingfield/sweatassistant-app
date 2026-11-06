// Security audit part 1: response headers. Boots the REAL server in production
// mode against a fixture build (PUBLIC_DIR) and asserts that the shell, the admin
// SPA, an API response, sw.js and the .ics route all carry nosniff,
// Referrer-Policy, frame-ancestors/X-Frame-Options, Permissions-Policy, COOP and
// an ENFORCED CSP whose script-src has no 'unsafe-inline' but does carry the
// sha256 of each inline <script> actually served. Also: HSTS in production only,
// HSTS_MAX_AGE=0 disables it, CSP_REPORT_ONLY=1 downgrades the CSP, and a
// non-production server sends no HSTS. Unit checks for inlineScriptHashes too.
// Usage: node server/test-security-headers.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { inlineScriptHashes, buildCsp } = require('./security-headers');

const INLINE_A = "\n  (function () { document.documentElement.dataset.x = '1'; })();\n";
const INLINE_B = 'setTimeout(function () {}, 1);';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-headers-'));
const pub = path.join(tmp, 'public');
fs.mkdirSync(path.join(pub, 'assets'), { recursive: true });
fs.writeFileSync(path.join(pub, 'index.html'),
  `<!doctype html><title>__APP_NAME__</title><script>${INLINE_A}</script><script>${INLINE_B}</script>`
  + '<script type="module" src="/assets/app.js"></script><script type="application/ld+json">{"a":1}</script>');
fs.writeFileSync(path.join(pub, 'manifest.json'), '{"name":"__APP_NAME__"}');
fs.writeFileSync(path.join(pub, 'sw.js'), '// sw');
fs.writeFileSync(path.join(pub, 'assets', 'app.js'), 'console.log(1)');

let n = 0;
const children = new Set();
function cleanup() {
  for (const c of children) { try { c.kill(); } catch (_) { /* gone */ } }
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function boot(extraEnv) {
  const port = 21000 + ((process.pid + 13 * ++n) % 20000);
  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: ':memory:', PUBLIC_DIR: pub,
      JWT_SECRET: 'test-sec-headers', ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
      ADMIN_PASSWORD: 'x', PUBLIC_HOST: 'app.test.example', VAPID_EMAIL: 'mailto:t@example.com',
      HSTS_MAX_AGE: '', CSP_REPORT_ONLY: '', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', () => {});
  const base = `http://127.0.0.1:${port}`;
  const start = Date.now();
  for (;;) {
    try { if ((await fetch(`${base}/api/config`)).ok) break; } catch (_) { /* not up */ }
    if (Date.now() - start > 15000) throw new Error('server did not start: ' + err);
    await new Promise((r) => setTimeout(r, 150));
  }
  return { base, stop: () => { child.kill(); children.delete(child); } };
}

function scriptSrc(csp) {
  const d = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src '));
  assert.ok(d, `CSP has a script-src: ${csp}`);
  return d;
}

function assertCommon(res, label) {
  const h = (k) => res.headers.get(k);
  assert.strictEqual(h('x-content-type-options'), 'nosniff', `${label}: nosniff`);
  assert.strictEqual(h('referrer-policy'), 'strict-origin-when-cross-origin', `${label}: Referrer-Policy`);
  assert.strictEqual(h('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
  assert.match(h('permissions-policy') || '', /camera=\(\)/, `${label}: Permissions-Policy`);
  assert.strictEqual(h('cross-origin-opener-policy'), 'same-origin', `${label}: COOP`);
  const csp = h('content-security-policy');
  assert.ok(csp, `${label}: enforced CSP present`);
  assert.match(csp, /frame-ancestors 'none'/, `${label}: frame-ancestors`);
  assert.match(csp, /object-src 'none'/, `${label}: object-src`);
  assert.match(csp, /base-uri 'self'/, `${label}: base-uri`);
  assert.ok(!scriptSrc(csp).includes("'unsafe-inline'"), `${label}: no unsafe-inline scripts`);
  assert.ok(!scriptSrc(csp).includes("'unsafe-eval'"), `${label}: no unsafe-eval`);
  return csp;
}

async function run() {
  // Unit: hashes cover inline executable scripts only.
  const hashes = inlineScriptHashes(`<script>${INLINE_A}</script><script src="/x.js"></script><script type="application/ld+json">{}</script><SCRIPT type="module">${INLINE_B}</SCRIPT>`);
  assert.deepStrictEqual(hashes.sort(), [sha(INLINE_A), sha(INLINE_B)].sort());
  assert.ok(buildCsp([sha(INLINE_A)]).includes(`'sha256-${sha(INLINE_A)}'`));
  console.log('PASS inlineScriptHashes picks inline executable scripts only');

  const prod = await boot({});
  try {
    // App shell: hashes of exactly the inline scripts served (after templating).
    const shell = await fetch(`${prod.base}/`);
    const shellCsp = assertCommon(shell, 'shell');
    const ss = scriptSrc(shellCsp);
    assert.ok(ss.includes(`'sha256-${sha(INLINE_A)}'`) && ss.includes(`'sha256-${sha(INLINE_B)}'`), `shell script-src carries both inline hashes: ${ss}`);
    assert.strictEqual(shell.headers.get('strict-transport-security'), 'max-age=15552000', 'HSTS in production, modest, no preload');
    console.log('PASS shell: headers + per-inline-script hashes + HSTS');

    // Admin SPA (real server/admin.html): its inline script must be hashed, or the admin page is dead.
    const admin = await fetch(`${prod.base}/admin`);
    const adminHtml = await admin.text();
    const adminCsp = assertCommon(admin, 'admin');
    const adminHashes = inlineScriptHashes(adminHtml);
    assert.ok(adminHashes.length >= 1, 'admin.html has an inline script to hash');
    for (const h of adminHashes) assert.ok(scriptSrc(adminCsp).includes(`'sha256-${h}'`), 'admin inline script hash present');
    console.log('PASS admin: inline script allowed by hash, nothing else inline');

    for (const [p, label] of [['/api/config', 'api'], ['/sw.js', 'sw.js'], ['/assets/app.js', 'asset'], ['/api/calendar/nope.ics', 'ics'], ['/no-such-page', '404']]) {
      assertCommon(await fetch(`${prod.base}${p}`), label);
    }
    console.log('PASS api, sw.js, assets, .ics and 404 carry the headers');
  } finally { prod.stop(); }

  const reportOnly = await boot({ CSP_REPORT_ONLY: '1', HSTS_MAX_AGE: '0' });
  try {
    const res = await fetch(`${reportOnly.base}/`);
    assert.strictEqual(res.headers.get('content-security-policy'), null, 'report-only: no enforced CSP');
    assert.match(res.headers.get('content-security-policy-report-only') || '', /sha256-/, 'report-only CSP carries hashes');
    assert.strictEqual(res.headers.get('strict-transport-security'), null, 'HSTS_MAX_AGE=0 disables HSTS');
    console.log('PASS CSP_REPORT_ONLY=1 and HSTS_MAX_AGE=0');
  } finally { reportOnly.stop(); }

  const dev = await boot({ NODE_ENV: 'development' });
  try {
    const res = await fetch(`${dev.base}/api/config`);
    assertCommon(res, 'dev api');
    assert.strictEqual(res.headers.get('strict-transport-security'), null, 'no HSTS outside production');
    console.log('PASS non-production: headers, no HSTS');
  } finally { dev.stop(); }
}

run().then(() => { cleanup(); console.log('ALL PASS test-security-headers'); process.exit(0); })
  .catch((e) => { console.error('FAIL', e); cleanup(); process.exit(1); });
