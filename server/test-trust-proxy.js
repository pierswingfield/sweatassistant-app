// Express `trust proxy` behind the Cloudflare Tunnel.
//
// Prod has no published port: cloudflared reaches the container over the `edge`
// network, so every socket peer is the tunnel. Without `trust proxy`, req.ip is
// that peer for EVERYONE and every per-IP express-rate-limit limiter shares one
// bucket (one abuser locks all members out; per-IP limits mean nothing).
//
// Boots the REAL server in NODE_ENV=production (the limiters are production-only)
// and drives authLoginLimiter (10 / 15 min per IP) with bad logins:
//   1. default (one hop trusted): distinct clients behind the proxy each get
//      their own bucket; one client is still limited; a client-forged leading
//      X-Forwarded-For entry ("forged, real") cannot dodge the limit.
//   2. TRUST_PROXY=0 (directly exposed): X-Forwarded-For is ignored, so it
//      cannot be used to mint fresh buckets.
// Usage: node server/test-trust-proxy.js
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let n = 0;
async function run(label, extraEnv, scenario) {
  const port = 20000 + ((process.pid + 7 * ++n) % 20000);
  const base = `http://127.0.0.1:${port}`;
  const dbPath = path.join(os.tmpdir(), `test-trust-proxy-${process.pid}-${n}.db`);
  const child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: {
      ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: dbPath,
      ENCRYPTION_KEY: 'a'.repeat(64), JWT_SECRET: 'test-secret', PUBLIC_HOST: 'example.test',
      VAPID_EMAIL: 'mailto:t@example.test', ADMIN_PASSWORD: '', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; ; i++) {
      try { await fetch(`${base}/api/health`); break; } catch (e) { /* not up yet */ }
      if (i > 100) throw new Error(`server did not start:\n${out.slice(-800)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const login = async (xff) => (await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'wrong' }),
    })).status;
    await scenario(login);
    console.log(`PASS ${label}`);
  } finally {
    child.kill();
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  }
}

(async () => {
  await run('one hop trusted: separate clients get separate buckets', {}, async (login) => {
    for (let i = 0; i < 12; i++) assert.notStrictEqual(await login(`203.0.113.${i + 1}`), 429, `client ${i + 1} was limited by others' traffic`);
  });
  await run('one hop trusted: a single client is still limited', {}, async (login) => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push(await login('198.51.100.9'));
    assert.strictEqual(codes[9] !== 429 && codes[10], 429, `expected 429 from the 11th attempt, got ${codes}`);
  });
  await run('one hop trusted: forged leading XFF entry cannot dodge the limit', {}, async (login) => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push(await login(`10.9.9.${i}, 198.51.100.7`));
    assert.strictEqual(codes[10], 429, `forged XFF minted fresh buckets: ${codes}`);
  });
  await run('TRUST_PROXY=0: XFF is ignored (no spoofing when exposed directly)', { TRUST_PROXY: '0' }, async (login) => {
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push(await login(`203.0.113.${i + 1}`));
    assert.strictEqual(codes[10], 429, `XFF spoof minted fresh buckets: ${codes}`);
  });
  console.log('trust-proxy: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
