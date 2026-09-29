// GET /api/auto-book bounds the executed-history rows it returns: nothing older
// than 90 days, and at most the 50 most recent. Pending rows are never dropped.
// Mock gym only (dev@psycle.com); no live calls.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-abhist.db');
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};

async function run() {
  cleanup();
  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;

  const db = new Database(DB_PATH);
  const user = db.prepare('SELECT id FROM users LIMIT 1').get();
  const ins = db.prepare(`INSERT INTO auto_bookings (user_id, gym_id, event_id, class_name, preferences, status, executed_at)
                          VALUES (?, 'psycle-london', ?, 'Test', '{}', ?, ?)`);
  const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();
  let ev = 9000;
  for (let i = 0; i < 60; i++) ins.run(user.id, ev++, 'success', daysAgo(1 + i * 0.5));   // 60 recent (<=30d)
  for (let i = 0; i < 5; i++) ins.run(user.id, ev++, 'success', daysAgo(120 + i));         // 5 too old
  ins.run(user.id, ev++, 'pending', null);                                                 // pending kept
  db.close();

  const r = await fetch(`${BASE}/api/auto-book?gymId=all`, { headers: H(t) });
  assert.strictEqual(r.status, 200);
  const rows = await r.json();
  const hist = rows.filter((x) => x.executed_at);
  assert.strictEqual(hist.length, 50, `history capped at 50, got ${hist.length}`);
  assert.ok(hist.every((x) => Date.parse(x.executed_at) > Date.now() - 90 * 86400000), 'no history older than 90 days');
  assert.strictEqual(rows.filter((x) => !x.executed_at).length, 1, 'pending row retained');
  console.log('✅ Auto-book history is capped (90 days, 50 rows); pending rows untouched.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 Auto-Book history cap\n');
  try { await run(); console.log('\n🎉 History cap PASSED.\n'); }
  catch (err) { failed = 1; console.error('\n❌ History cap FAILED:\n', err, '\n'); }
  finally { cleanup(); }
  process.exit(failed);
})();
