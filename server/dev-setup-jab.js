#!/usr/bin/env node
/**
 * Dev-only: put a running dev server into the "JAB smoke test" state.
 *
 * Replaces the hand-run fetches in Backlog/modular-gyms/OUTSTANDING.md — logging
 * in, linking the JAB mock account, and selecting it. Everything it does is
 * against the DEV MOCKS (dev@psycle.com / dev@jabboxing.mock); it touches no
 * live gym and stores no real credential.
 *
 * Usage:
 *   1. Set `enabled: true` on jab-boxing in gyms.config.js  (the rollout gate)
 *   2. npm run dev
 *   3. node server/dev-setup-jab.js            # or: --gym <gymId>
 *   4. Paste the printed localStorage lines into the browser console, reload
 *   5. REVERT the gate when done
 *
 * Deliberately NOT named test-*.js so run-tests.js does not pick it up.
 */

const BASE = process.env.SA_BASE || 'http://localhost:3000';
const SA_EMAIL = 'dev@psycle.com';
const SA_PASSWORD = 'devpassword';

// Which gym to set up. No gym id is hardcoded here — test-no-gym-privilege.js
// scans for that and is right to: a literal would need editing the day a third
// gym arrives, which is the property this phase exists to protect. With no
// --gym, target the first enabled gym that ISN'T the default, which is exactly
// "the one we are trying out".
const argGymArg = (() => {
  const i = process.argv.indexOf('--gym');
  return i > -1 ? process.argv[i + 1] : null;
})();

// Mock gym logins, keyed by PLATFORM rather than by gym: the dev mocks are per
// platform (mock.js for CodexFit, mock-marianatek.js for MarianaTek), so this
// keeps working for a second gym on either one.
const MOCK_LOGIN_BY_PROVIDER = {
  codexfit: SA_EMAIL,
  marianatek: 'dev@jabboxing.mock',
};

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { _raw: text.slice(0, 300) }; }
}

function die(msg, detail) {
  console.error(`\n✗ ${msg}`);
  if (detail) console.error(`  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  process.exit(1);
}

(async () => {
  // 1. Server up? Poll rather than assume — a page loaded before the server
  //    answers produces fake failures (OUTSTANDING.md trap 6).
  let health = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { health = await json(r); break; }
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!health) die(`No server at ${BASE} after 20s.`, 'Run `npm run dev` first.');
  console.log(`✓ server up — nextReleaseAt: ${health.nextReleaseAt ?? 'null (nothing queued)'}`);

  // 2. Is the gym even enabled? This is the gate, and forgetting it is the most
  //    common reason the next step 403s.
  const cat = await json(await fetch(`${BASE}/api/gyms`));
  const cfg = require('./gyms.config');
  const gyms = cat.gyms || [];
  // With no --gym, target the first enabled gym that ISN'T the default — that is
  // "the one we are trying out". Do NOT silently fall back to the default when
  // none is enabled: the whole point of running this is to exercise the other
  // gym, and quietly setting up the default instead looks like success while
  // testing nothing. Say the gate is shut.
  const candidate = gyms.find((g) => g.enabled && g.id !== cfg.DEFAULT_GYM_ID);
  if (!argGymArg && !candidate) {
    const others = gyms.filter((g) => g.id !== cfg.DEFAULT_GYM_ID);
    die(others.length
      ? `No non-default gym is enabled — the rollout gate is shut.`
      : `Only the default gym (${cfg.DEFAULT_GYM_ID}) is configured; nothing to try out.`,
    others.length
      ? `Set enabled: true on one of: ${others.map((g) => g.id).join(', ')} in server/gyms.config.js, `
        + `restart the server, and re-run. REVERT IT AFTERWARDS. `
        + `(Pass --gym ${cfg.DEFAULT_GYM_ID} if you really did want the default.)`
      : undefined);
  }
  const argGym = argGymArg || candidate.id;
  const target = gyms.find((g) => g.id === argGym);
  if (!target) {
    die(`Gym "${argGym}" is not in the catalogue.`,
      `Configured: ${(cat.gyms || []).map((g) => `${g.id}(${g.enabled ? 'on' : 'OFF'})`).join(', ')}`);
  }
  if (!target.enabled) {
    die(`Gym "${argGym}" is enabled: false — that is the rollout gate.`,
      `Set enabled: true on it in server/gyms.config.js, restart the server, and re-run. REVERT IT AFTERWARDS.`);
  }
  console.log(`✓ ${target.name} is enabled (provider: ${target.provider})`);

  // 3. Log in to the Sweat Assistant account (dev mock: any password).
  const login = await json(await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SA_EMAIL, password: SA_PASSWORD }),
  }));
  if (!login.token) die('Login failed.', login);
  // The id is on `user`, not the envelope — the client reads `data.user.id` and
  // sets it as the IndexedDB cache-key prefix, so getting this wrong silently
  // produces an unprefixed cache.
  const userId = login.user && login.user.id;
  if (userId == null) die('Login returned no user id.', login);
  const H = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
  console.log(`✓ logged in as ${SA_EMAIL} (user ${userId})`);

  // 4. Link the gym, unless already linked. Linking is idempotent — it doubles
  //    as "re-authenticate a stale credential" — so this is safe to re-run.
  if (argGym !== cfg.DEFAULT_GYM_ID) {
    const gymEmail = MOCK_LOGIN_BY_PROVIDER[target.provider];
    if (!gymEmail) die(`No dev mock login known for provider "${target.provider}".`,
      'Add it to MOCK_LOGIN_BY_PROVIDER, or pass an account that exists in that mock.');
    const link = await json(await fetch(`${BASE}/api/my-gyms/link`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ gymId: argGym, email: gymEmail, password: 'x' }),
    }));
    if (!link.gym) die(`Linking ${argGym} failed.`, link);
    console.log(`✓ linked ${argGym} as ${link.gym.gym_email}`);
  }

  // 5. Select it.
  const active = await json(await fetch(`${BASE}/api/my-gyms/active`, {
    method: 'POST', headers: H, body: JSON.stringify({ gymId: argGym }),
  }));
  if (active.activeGymId !== argGym) die('Setting the active gym failed.', active);

  const mine = await json(await fetch(`${BASE}/api/my-gyms`, { headers: H }));
  console.log(`✓ active gym: ${active.activeGymId}`);
  console.log(`  linked: ${(mine.gyms || []).map((g) => g.gym_id).join(', ')}`);

  // 6. Sanity-check the timetable actually returns that gym's classes. Catches
  //    the failure mode where the server is right but the client shows stale
  //    data — if this prints JAB classes and the browser shows Psycle ones, the
  //    problem is a cache key, not the adapter.
  const tt = await json(await fetch(`${BASE}/api/timetable`, { headers: { ...H, 'x-gym-id': argGym } }));
  const arr = Array.isArray(tt) ? tt : (tt.events || tt.data || []);
  console.log(`✓ /api/timetable → ${arr.length} classes`);
  for (const e of arr.slice(0, 3)) {
    console.log(`    ${e.startAt}  ${e.discipline ?? '?'}  ${e.name}  @ ${e.locationName ?? '?'}`);
  }

  console.log(`\n── paste into the browser console at http://localhost:5173, then reload ──`);
  console.log(`localStorage.setItem('psycleLocalToken', ${JSON.stringify(login.token)});`);
  console.log(`localStorage.setItem('psycleUserId', ${JSON.stringify(String(userId))});`);
  console.log(`localStorage.setItem('sweatActiveGymId', ${JSON.stringify(argGym)});`);
  console.log(`location.reload();`);
  console.log(`\nSwitch back with:  node server/dev-setup-jab.js --gym ${cfg.DEFAULT_GYM_ID}`);
  console.log(`Remember to revert enabled:false on jab-boxing when you finish.\n`);
})().catch((err) => die('Unexpected error.', err.stack || err.message));
