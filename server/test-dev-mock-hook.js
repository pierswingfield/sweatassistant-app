// The dev mock is driven by the gym config's `devMock.email` through two adapter
// hooks, never by a dev email compared in core code. Never active in production.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';
process.env.JAB_BOXING_ENABLED = 'true';

const assert = require('assert');
const { listDevMockGyms, findDevMockGym } = require('./gyms.config');
const { getProvider } = require('./providers');

let n = 0;
const check = (name, fn) => { fn(); n += 1; console.log(`  ok  ${name}`); };
const withEnv = (v, fn) => { const o = process.env.NODE_ENV; process.env.NODE_ENV = v; try { return fn(); } finally { if (o === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = o; } };

const [first, second] = listDevMockGyms();
assert.ok(first && second, 'at least two gyms declare a devMock');

check('findDevMockGym maps an email to exactly its gym (case-insensitive)', () => {
  assert.strictEqual(findDevMockGym(first.devMock.email.toUpperCase()).id, first.id);
  assert.strictEqual(findDevMockGym(second.devMock.email).id, second.id);
  assert.strictEqual(findDevMockGym('real.person@example.com'), null);
  assert.strictEqual(findDevMockGym(''), null);
});
check('isMockLogin is per gym', () => {
  assert.strictEqual(getProvider(first.id).isMockLogin(first.devMock.email), true);
  assert.strictEqual(getProvider(first.id).isMockLogin(second.devMock.email), false);
  assert.strictEqual(getProvider(second.id).isMockLogin(second.devMock.email), true);
});
check('isMockUser: mock-token session, or the gym\'s own dev account; nothing else', () => {
  const p = getProvider(first.id);
  assert.strictEqual(p.isMockUser({ email: first.devMock.email }, null), true);
  assert.strictEqual(p.isMockUser({ email: 'x@example.com' }, { accessToken: p.mockToken }), true);
  assert.strictEqual(p.isMockUser({ email: 'x@example.com' }, { accessToken: 'real-token' }), false);
  assert.strictEqual(p.isMockUser(null, null), false);
});
check('production disables every mock hook', () => withEnv('production', () => {
  const p = getProvider(first.id);
  assert.strictEqual(p.isMockLogin(first.devMock.email), false);
  assert.strictEqual(p.isMockUser({ email: first.devMock.email }, { accessToken: p.mockToken }), false);
}));
console.log(`🎉 ${n}/${n} dev-mock-hook checks passed.`);
