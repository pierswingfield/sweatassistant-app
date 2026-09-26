// C3-11 — the invalid-credentials error must name the GYM that rejected it.
//
// providers/codexfit.js's login() threw a gym-less "Invalid email or
// password." (or a bare "Login failed with status …"), and
// providers/marianatek.js's login() threw "MarianaTek login failed: …" — the
// PLATFORM name, not the gym's. Confirmed by reading both before this test
// (2026-09-26): neither referenced `this.gym` at all in the error path, even
// though both classes already carry `this.gym` (base.js's constructor) and
// use it elsewhere. A member linking a second gym with the wrong password saw
// a message that could be about any gym, or (for MarianaTek) named the
// platform instead — meaningless to a JAB member.
//
// NOTE ON BROWSER VERIFICATION (per AGENT_PROTOCOL.md): the mandated
// real-browser check ("link-gym flow with a wrong password against the
// mock") is not reproducible as written — both dev mock accounts
// (dev@psycle.com, dev@jabboxing.mock) bypass password validation entirely
// by design (`email === DEV_EMAIL` short-circuits before any credential
// check — see codexfit.js login() and marianatek.js login()), and any other
// email routes to the REAL gym over the network, which is live traffic this
// pass must not make (AGENTS.md/LIVE_VERIFICATION_PLAYBOOK.md). So this is
// exercised at the adapter level instead, with `fetch` stubbed to return the
// exact rejection shapes documented in psycle_codexfit.md / marianatek.md —
// this is the strongest evidence available without violating the no-live-
// traffic rule, and is noted as a browser-check substitution in the C3 doc.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { getProvider } = require('./providers');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }

check('CodexFit (Psycle): a rejected login names "Psycle", not a generic message', async () => {
  global.fetch = async (url, opts) => {
    if (String(url).includes('/auth/login')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ message: 'These credentials do not match our records.' }),
      };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
  try {
    const provider = getProvider('psycle-london');
    await assert.rejects(
      () => provider.login({ email: 'wrong@test.local', password: 'wrong' }),
      (err) => {
        assert.ok(/Psycle/.test(err.message), `expected "Psycle" in the error, got: ${err.message}`);
        assert.ok(/credentials do not match/.test(err.message), `expected the original reason preserved, got: ${err.message}`);
        assert.ok(!/JAB/.test(err.message));
        return true;
      },
    );
  } finally { restoreFetch(); }
});

check('MarianaTek (JAB): a rejected login names "JAB", not "MarianaTek"', async () => {
  const authorizeLocation = 'https://jabboxingclub.marianatek.com/accounts/login/?next=%2Fo%2Fauthorize%2F%3Fnext_thing';
  const loginPageHtml = '<html><input type="hidden" name="csrfmiddlewaretoken" value="tok123"></html>';

  let call = 0;
  global.fetch = async (url, opts) => {
    call++;
    const u = String(url);
    if (call === 1) {
      // Step 1: authorize -> redirect to login page
      assert.ok(u.includes('/o/authorize/'), `call 1 expected authorize, got ${u}`);
      return { status: 302, headers: { get: (h) => (h === 'location' ? authorizeLocation : null), getSetCookie: () => [] } };
    }
    if (call === 2) {
      // Step 2: GET login page
      return {
        ok: true,
        status: 200,
        headers: { get: () => null, getSetCookie: () => ['csrftoken=abc; Path=/'] },
        text: async () => loginPageHtml,
      };
    }
    if (call === 3) {
      // Step 3: POST credentials -> re-renders the login page (200, no redirect) == wrong password
      return { status: 200, headers: { get: () => null, getSetCookie: () => [] } };
    }
    throw new Error(`unexpected extra fetch call ${call}: ${u}`);
  };

  try {
    const provider = getProvider('jab-boxing');
    await assert.rejects(
      () => provider.login({ email: 'wrong@test.local', password: 'wrong' }),
      (err) => {
        assert.ok(/JAB/.test(err.message), `expected "JAB" in the error, got: ${err.message}`);
        assert.ok(!/MarianaTek/.test(err.message), `must not name the platform instead of the gym, got: ${err.message}`);
        return true;
      },
    );
  } finally { restoreFetch(); }
});

(async () => {
  let failed = 0;
  console.log('\n🧪 C3-11: invalid-credentials error names the gym\n');
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.stack || err.message}`); }
  }
  restoreFetch();
  if (failed > 0) {
    console.error(`\n${failed}/${checks.length} invalid-credentials-naming checks FAILED.`);
    process.exit(1);
  }
  console.log(`\n🎉 ${checks.length}/${checks.length} invalid-credentials-naming checks passed.`);
})();
