// F-12 (gym-neutral favourites): a favourite is a recurring slot = gym + studio +
// weekday + start time (gym-local). Psycle keeps its NATIVE CodexFit bookmarks; every
// gym without native bookmarks uses the local `favourites` table. One API for both.
//
// Sections: (1) pure slot/identifier helpers, (2) db scoping (WP-D6 rules),
// (3) the HTTP contract against the dev mocks (native + local path, gym required,
// isolation, unlink cleanup, validation).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- 1. pure helpers ---------------------------------------------------------

check('identifier formula matches the CodexFit bookmark key and round-trips', () => {
  const fav = require('./favourites');
  assert.strictEqual(fav.toIdentifier({ studioId: '138', dayOfWeek: 1, startTime: '1930' }), '1380000100001930');
  assert.deepStrictEqual(fav.parseIdentifier('1380000100001930'), { studioId: '138', dayOfWeek: 1, startTime: '1930' });
  // A studio id that itself contains 0000 still parses, because the tail is fixed width.
  const odd = fav.toIdentifier({ studioId: '100001', dayOfWeek: 0, startTime: '0615' });
  assert.deepStrictEqual(fav.parseIdentifier(odd), { studioId: '100001', dayOfWeek: 0, startTime: '0615' });
  assert.strictEqual(fav.parseIdentifier('nonsense'), null);
  assert.strictEqual(fav.parseIdentifier('1380000900001930'), null, 'weekday 9 is not a weekday');
});

check('slotOfEvent reads weekday and start time in the CLASS zone, not the host zone', () => {
  const fav = require('./favourites');
  // 23:30 UTC Sunday is 19:30 Sunday in New York (EDT) but 00:30 Monday in London (BST).
  const ev = { studioId: 7, startAt: '2026-06-07T23:30:00Z', timeZone: 'America/New_York' };
  assert.deepStrictEqual(fav.slotOfEvent(ev), { studioId: '7', dayOfWeek: 0, startTime: '1930' });
  const ldn = { studioId: 7, startAt: '2026-06-07T23:30:00Z', timeZone: 'Europe/London' };
  assert.deepStrictEqual(fav.slotOfEvent(ldn), { studioId: '7', dayOfWeek: 1, startTime: '0030' });
  assert.strictEqual(fav.slotOfEvent({ studioId: 7 }), null);
});

check('validateSlot accepts only well-formed slots and trims labels', () => {
  const fav = require('./favourites');
  assert.ok(fav.validateSlot({ studioId: '138', dayOfWeek: 1, startTime: '1930' }).ok);
  for (const bad of [
    { studioId: '', dayOfWeek: 1, startTime: '1930' },
    { studioId: '1', dayOfWeek: 7, startTime: '1930' },
    { studioId: '1', dayOfWeek: 1, startTime: '2560' },
    { studioId: '1', dayOfWeek: 1, startTime: '930' },
    { studioId: '1', dayOfWeek: 'x', startTime: '0930' },
    null,
  ]) assert.strictEqual(fav.validateSlot(bad).ok, false, JSON.stringify(bad));
  const v = fav.validateSlot({ studioId: 5, dayOfWeek: '2', startTime: '0600', className: '  Ride  ' });
  assert.strictEqual(v.value.className, 'Ride');
  assert.strictEqual(v.value.studioId, '5');
  assert.strictEqual(v.value.dayOfWeek, 2);
});

// --- 2. db scoping -----------------------------------------------------------

check('favourites are gym-scoped, unique per slot, and cleared on unlink', () => {
  const db = require('./db');
  db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');
  const uid = db.createUser(`fav-${Date.now()}@test.local`, 'enc:pw');
  db.upsertUserGym(uid, 'jab-boxing', { gym_email: 'b@test.local', encrypted_password: 'enc:b' });
  const slot = { studioId: '138', dayOfWeek: 1, startTime: '1930', className: 'Ride' };

  db.addFavourite(uid, 'psycle-london', slot);
  db.addFavourite(uid, 'psycle-london', slot); // idempotent
  assert.strictEqual(db.listFavourites(uid, 'psycle-london').length, 1);
  // The SAME provider studio id at another gym is a different room.
  assert.deepStrictEqual(db.listFavourites(uid, 'jab-boxing'), []);
  db.addFavourite(uid, 'jab-boxing', slot);
  assert.strictEqual(db.listFavourites(uid, 'jab-boxing').length, 1);

  // Two-gym account with no gym named is a call-site bug, not a plausible answer.
  assert.throws(() => db.listFavourites(uid), /no gym specified/);
  // A request context supplies the gym.
  assert.strictEqual(db.runWithGymContext(uid, 'jab-boxing', () => db.listFavourites(uid)).length, 1);

  assert.strictEqual(db.removeFavourite(uid, 'jab-boxing', slot), true);
  assert.strictEqual(db.removeFavourite(uid, 'jab-boxing', slot), false);
  assert.strictEqual(db.listFavourites(uid, 'psycle-london').length, 1, 'removal did not touch the other gym');

  db.addFavourite(uid, 'jab-boxing', slot);
  db.unlinkGym(uid, 'jab-boxing');
  assert.strictEqual(db.db.prepare('SELECT COUNT(*) c FROM favourites WHERE user_id = ? AND gym_id = ?').get(uid, 'jab-boxing').c, 0);
  assert.strictEqual(db.listFavourites(uid, 'psycle-london').length, 1);
});

check('gym_id is NOT NULL on favourites', () => {
  const db = require('./db');
  const cols = db.db.prepare("PRAGMA table_info('favourites')").all();
  const g = cols.find((c) => c.name === 'gym_id');
  assert.ok(g && g.notnull === 1 && g.dflt_value == null, 'gym_id must be NOT NULL with no default');
});

// --- 3. HTTP contract --------------------------------------------------------

const PORT = 3095;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-fav.db');
let child;
const cleanup = () => {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};

check('HTTP: native path (Psycle), local path (JAB), isolation, validation', async () => {
  cleanup();
  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const H = (t, g) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}`, ...(g ? { 'x-gym-id': g } : {}) });
  const call = async (method, p, t, g, body) => {
    const r = await fetch(`${BASE}${p}`, { method, headers: H(t, g), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  const PS = 'psycle-london', JAB = 'jab-boxing';
  const link = () => call('POST', '/api/my-gyms/link', t, null, { gymId: JAB, email: 'dev@jabboxing.mock', password: 'x' });
  await call('DELETE', `/api/my-gyms/${JAB}`, t);

  // Single gym: no header needed.
  let r = await call('GET', '/api/favourites', t);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.gymId, PS);
  assert.strictEqual(r.body.native, true);
  assert.ok(Array.isArray(r.body.favourites));

  await link();
  r = await call('GET', '/api/favourites', t);
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'GYM_REQUIRED');

  const slot = { studioId: '138', dayOfWeek: 1, startTime: '1930', className: 'Ride', studioName: 'Studio A' };
  // Native: delegates to the provider's bookmarks; the mock profile then lists it.
  r = await call('PUT', '/api/favourites', t, PS, slot);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.id, '1380000100001930');
  // The listing is read back FROM the provider (mock CodexFit profile metafields), not from our db.
  const Database = require('better-sqlite3');
  const peek = new Database(DB_PATH, { readonly: true });
  assert.strictEqual(peek.prepare("SELECT COUNT(*) c FROM favourites WHERE gym_id = 'psycle-london'").get().c, 0,
    'native gym must NOT write the local table');
  peek.close();
  r = await call('GET', '/api/favourites', t, PS);
  assert.ok(r.body.favourites.some((f) => f.id === '1380000100001930' && f.studioId === '138' && f.dayOfWeek === 1 && f.startTime === '1930'));
  assert.strictEqual(r.body.native, true);

  // Local: the same slot at JAB is a separate favourite and Psycle's is not visible.
  r = await call('GET', '/api/favourites', t, JAB);
  assert.strictEqual(r.body.native, false); assert.deepStrictEqual(r.body.favourites, []);
  r = await call('PUT', '/api/favourites', t, JAB, slot);
  assert.strictEqual(r.status, 200);
  r = await call('PUT', '/api/favourites', t, JAB, slot);
  assert.strictEqual(r.status, 200, 'idempotent');
  r = await call('GET', '/api/favourites', t, JAB);
  assert.strictEqual(r.body.favourites.length, 1);
  assert.strictEqual(r.body.favourites[0].className, 'Ride');

  // Validation.
  r = await call('PUT', '/api/favourites', t, JAB, { studioId: '1', dayOfWeek: 9, startTime: '1930' });
  assert.strictEqual(r.status, 400);
  r = await call('DELETE', '/api/favourites/garbage', t, JAB);
  assert.strictEqual(r.status, 400);

  // Delete only touches the named gym.
  r = await call('DELETE', '/api/favourites/1380000100001930', t, JAB);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await call('GET', '/api/favourites', t, JAB)).body.favourites, []);
  assert.ok((await call('GET', '/api/favourites', t, PS)).body.favourites.some((f) => f.id === '1380000100001930'));
  r = await call('DELETE', '/api/favourites/1380000100001930', t, PS);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await call('GET', '/api/favourites', t, PS)).body.favourites.length, 0);

  // Unlink + relink must not resurrect or leak.
  await call('PUT', '/api/favourites', t, JAB, slot);
  await call('DELETE', `/api/my-gyms/${JAB}`, t);
  await link();
  assert.deepStrictEqual((await call('GET', '/api/favourites', t, JAB)).body.favourites, []);
  await call('DELETE', `/api/my-gyms/${JAB}`, t);
});

(async () => {
  let failed = 0;
  console.log('\nF-12: gym-neutral favourites\n');
  for (const c of checks) {
    try { await c.fn(); console.log(`  ok  ${c.name}`); }
    catch (err) { failed++; console.error(`  FAIL ${c.name}\n`, err && err.message ? err.message : err); }
  }
  cleanup();
  if (failed) { console.error(`\n${failed} failed\n`); process.exit(1); }
  console.log(`\nF-12 PASSED (${checks.length} checks).\n`);
  process.exit(0);
})();
