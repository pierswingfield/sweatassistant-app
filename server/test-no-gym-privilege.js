// The acceptance test, as a test (WP-D7).
//
// The goal of this phase is not "make JAB work" — that is satisfied by adding a
// MarianaTek branch beside each CodexFit assumption, which leaves Psycle as the
// base case and the next gym as another branch. The goal is that no gym is
// privileged above the adapter layer:
//
//     Delete `psycle-london` from gyms.config.js.
//     Nothing outside providers/codexfit.js should break.
//
// That is hard to assert directly, so this suite asserts the properties that
// make it true, by reading the source. Source-scanning tests are usually a smell
// — but the thing being prevented here IS a source-level property ("no module
// names a gym"), and it is one that reviewers demonstrably miss: every item
// below was live in the codebase and passing every other suite.
//
// Three layers, for reference (stakeholder, 2026-08-31):
//   platform module (providers/*.js)  — the protocol, shared by every tenant
//   gym config      (gyms.config.js)  — the instance and its policy
//   app             (everything else) — normalized types + capability flags only

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const SERVER_DIR = __dirname;

// Application modules — everything in server/ that is not a provider adapter,
// not the gym registry, and not a test.
function appModules() {
  return fs.readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !f.startsWith('test-'))
    .filter((f) => f !== 'gyms.config.js')
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(SERVER_DIR, f), 'utf8') }));
}

// Strip comments so prose about CodexFit doesn't read as a dependency on it.
// (Deliberately crude: it only has to be good enough to drop // and /* */.)
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    // SQL comments too: db.js's schema lives in template literals, so `-- ...`
    // prose inside it is not code and must not read as a dependency.
    .replace(/^\s*--.*$/gm, '')
    .replace(/\s--\s.*$/gm, '');
}

// --- 1. no module picks a gym for itself ------------------------------------

check('no application module resolves a provider at import time', () => {
  const offenders = [];
  for (const { name, src } of appModules()) {
    for (const line of stripComments(src).split('\n')) {
      // Two distinct smells, both meaning "this module picked a gym for itself":
      //   * a TOP-LEVEL const (column 0) — evaluated once at require time, so it
      //     pins every user of the module to one gym for the process lifetime;
      //   * a STRING-LITERAL argument at any depth — names a specific gym.
      // `getProvider(gymId)` inside a function is the correct shape and passes.
      const topLevelConst = /^const\s+\w+\s*=\s*getProvider\s*\(/.test(line);
      const literalArg = /getProvider\s*\(\s*['"`]/.test(line);
      if (topLevelConst || literalArg) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'resolve the provider per request (active gym) or per row (row.gym_id) instead');
});

check('no application module hardcodes a gym id', () => {
  const offenders = [];
  for (const { name, src } of appModules()) {
    const code = stripComments(src);
    for (const line of code.split('\n')) {
      if (!/['"]psycle-london['"]|['"]jab-boxing['"]/.test(line)) continue;
      // db.js's historical migration statements are the one legitimate case:
      // they describe the schema as it was, and must NOT start reading the
      // current default gym, or past migrations would change retroactively.
      if (name === 'db.js' && /ensureColumn|DEFAULT|GYM_DEFAULT_RE|CREATE TABLE|gym_id TEXT/.test(line)) continue;
      offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'import DEFAULT_GYM_ID from gyms.config.js, or resolve the gym from the user/row');
});

check('no application module names a dev mock email (gyms.config devMock + adapter.isMockUser own that)', () => {
  const MOCKS = new Set(['mock.js', 'mock-marianatek.js']); // the mocks' own fixture data
  const offenders = [];
  for (const { name, src } of appModules()) {
    if (MOCKS.has(name)) continue;
    for (const line of stripComments(src).split('\n')) {
      if (/dev@[a-z0-9.-]+\.(com|mock)/i.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'ask gym.devMock.email / provider.isMockLogin(email) / provider.isMockUser(user, session) instead');
});

// --- 2. no module hardcodes one platform's host or names it ------------------

check('no application module hardcodes a provider hostname', () => {
  const offenders = [];
  for (const { name, src } of appModules()) {
    for (const line of stripComments(src).split('\n')) {
      if (/https?:\/\/[a-z0-9.-]*(codexfit|marianatek|marianaiframes)\.com/i.test(line)) {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [],
    'pass a PATH and let the provider prepend its own gym.apiBaseUrl — an absolute ' +
    'URL bypasses that and pins every gym to one platform\'s host');
});

check('no application identifier is named after one platform', () => {
  const offenders = [];
  for (const { name, src } of appModules()) {
    const code = stripComments(src);
    // Identifiers, not prose: `const codexfit =`, `fetchCodexFit(`, `.codexfit`.
    const m = code.match(/\b(?:const|let|var|function|async function)\s+\w*[Cc]odex[Ff]it\w*|\b\w*[Cc]odex[Ff]it\w*\s*\(/g);
    if (m) offenders.push(`${name}: ${[...new Set(m)].join(', ')}`);
  }
  assert.deepStrictEqual(offenders, [],
    'a variable named after one platform, holding an arbitrary provider, is how the ' +
    'next assumption gets written — name it for the role, not the vendor');
});

// --- 3. the registry stays the single source of gym truth --------------------

check('every configured gym resolves to a provider that implements the contract', () => {
  const { listGyms } = require('./gyms.config');
  const { getProvider } = require('./providers');
  const { GymProvider } = require('./providers/base');
  // Only the methods the app above actually calls. If a gym is in the registry,
  // enabled or not, every one of these must be real — a gym that half-implements
  // the contract fails at the worst moment rather than at boot.
  const REQUIRED = ['login', 'refreshSession', 'fetchTimetable', 'fetchEventDetails',
    'fetchStudioLayout', 'getProfile', 'bookSlot', 'cancelBooking', 'joinWaitlist',
    'leaveWaitlist', 'listBookings', 'listWaitlists', 'swapSpots', 'request',
    'publicRequest', 'isPublicRead', 'findInstructorPhoto'];

  for (const gym of listGyms()) {
    const p = getProvider(gym.id);
    assert.ok(p, `no provider for gym "${gym.id}"`);
    const missing = REQUIRED.filter((m) => typeof p[m] !== 'function' || p[m] === GymProvider.prototype[m]);
    assert.deepStrictEqual(missing, [],
      `${gym.id} (${gym.provider}) does not implement: ${missing.join(', ')}`);
  }
});

check('every configured gym declares the capability flags the UI gates on', () => {
  const { listGyms } = require('./gyms.config');
  const REQUIRED = ['atomicSwap', 'nativeWaitlist', 'metered', 'creditPurchase', 'bookmarks', 'bookingWindow'];
  for (const gym of listGyms()) {
    const caps = gym.capabilities || {};
    const missing = REQUIRED.filter((k) => caps[k] === undefined);
    assert.deepStrictEqual(missing, [],
      `${gym.id} is missing capability flags: ${missing.join(', ')} — an undefined flag ` +
      'reads as falsy and silently hides a feature the gym actually has');
  }
});

// --- timezone: no literal zone outside the gym config ------------------------

check("no literal 'Europe/London' outside gyms.config.js, booking-window defaults and the .ics VTIMEZONE", () => {
  const files = appModules().map((m) => ({ ...m, name: m.name }));
  const provDir = path.join(SERVER_DIR, 'providers');
  for (const f of fs.readdirSync(provDir).filter((x) => x.endsWith('.js'))) {
    files.push({ name: `providers/${f}`, src: fs.readFileSync(path.join(provDir, f), 'utf8') });
  }
  const offenders = [];
  for (const { name, src } of files) {
    if (name === 'providers/booking-window.js') continue; // policy-zone defaults
    stripComments(src).split('\n').forEach((line, i) => {
      if (!/Europe\/London/.test(line)) return;
      if (name === 'calendar.js' && /TZID|X-WR-TIMEZONE|zoneName ===/.test(line)) return; // the feed's one VTIMEZONE
      offenders.push(`${name}:${i + 1}`);
    });
  }
  assert.deepStrictEqual(offenders, [],
    "a literal 'Europe/London' is a gym's zone hardcoded; resolve it via providers/timezone.js: " + offenders.join(', '));
});

// --- run --------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of checks) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks.length} no-gym-privilege checks FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${passed}/${checks.length} no-gym-privilege checks passed.`);
