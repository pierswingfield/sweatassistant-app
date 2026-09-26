// C2-1 — CodexFit v2 cart contract test.
//
// Asserts two things:
//   1. CONTRACT FIDELITY — providers/codexfit-cart.js sends the exact
//      method/path/body the live capture recorded (server/fixtures/codexfit-v2/
//      PARITY.md's G3 row + cart-v2-lifecycle.json), by stubbing
//      CodexFitProvider.prototype.requestV2 and recording calls. No network.
//   2. MOCK ROUND-TRIP — server/mock.js's v2 cart handlers answer with the
//      same envelope shapes the fixture captured (no `stripe` key on an
//      empty/fresh cart, a PaymentIntent once a line is added, a zero-amount
//      SetupIntent once emptied again), exercised through the real dev-mode
//      path (provider.request with the mock sentinel token) so dev checkout
//      is actually covered, not just the protocol layer.
//
// Convention: plain-Node assertions, run directly: node server/test-codexfit-v2-cart.js

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');

const provider = getProvider('psycle-london');
const MOCK_SESSION = { accessToken: 'mock-jwt-token' };

const fakeRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
});

async function withStub(impl, fn) {
  const original = CodexFitProvider.prototype.requestV2;
  CodexFitProvider.prototype.requestV2 = impl;
  try { return await fn(); }
  finally { CodexFitProvider.prototype.requestV2 = original; }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
let passed = 0;

// ===========================================================================
// 1. Contract fidelity — method/path/body match the live capture
// ===========================================================================

check('initCart: POST /cart with an empty body', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    return fakeRes({ data: { uuid: 'test-uuid', currency: 'GBP', metadata: { organisation: null } } });
  }, async () => {
    const cartData = await provider.initCart({ accessToken: 'real-token' });
    assert.strictEqual(cartData.uuid, 'test-uuid');
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathOrUrl, '/cart');
  assert.strictEqual(calls[0].method, 'POST');
  assert.deepStrictEqual(calls[0].body, {}, 'init body is {} per PARITY.md G3');
});

check('addBundleToCart: add-line body has NO quantity field (confirmed live, PARITY.md G3)', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    return fakeRes({ data: { id: 1, hash: 'abc123', quantity: 1 }, message: 'Added to cart' });
  }, async () => {
    await provider.addBundleToCart('test-uuid', 2, 1, { accessToken: 'real-token' });
  });
  assert.strictEqual(calls.length, 1, 'quantity 1 makes exactly one call (no increment needed)');
  assert.strictEqual(calls[0].pathOrUrl, '/cart/test-uuid/lines');
  assert.strictEqual(calls[0].method, 'POST');
  assert.deepStrictEqual(calls[0].body, { type: 'bundle', id: 2 }, 'no `quantity` key — the doc\'s claim was wrong per the live capture');
});

check('addBundleToCart: quantity > 1 adds once then increments (qty - 1) times', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    if (opts.method === 'POST') return fakeRes({ data: { id: 1, hash: 'abc123', quantity: 1 } });
    return fakeRes({ data: { id: 1, hash: 'abc123', quantity: (opts.body.action === 'increment' ? 2 : 1) } });
  }, async () => {
    await provider.addBundleToCart('test-uuid', 2, 3, { accessToken: 'real-token' });
  });
  assert.strictEqual(calls.length, 3, '1 add-line + 2 increments for qty=3');
  assert.strictEqual(calls[0].method, 'POST');
  assert.strictEqual(calls[1].pathOrUrl, '/cart/test-uuid/lines/abc123');
  assert.strictEqual(calls[1].method, 'PUT');
  assert.deepStrictEqual(calls[1].body, { hash: 'abc123', action: 'increment' });
  assert.strictEqual(calls[2].method, 'PUT');
});

check('removeCartLine: DELETE /cart/{uuid}/lines/{hash}', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    return fakeRes({ message: 'Removed from cart' });
  }, async () => {
    await provider.removeCartLine('test-uuid', 'abc123', { accessToken: 'real-token' });
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathOrUrl, '/cart/test-uuid/lines/abc123');
  assert.strictEqual(calls[0].method, 'DELETE');
});

check('getCart: GET /cart/{uuid}, no body', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    return fakeRes({ data: { uuid: 'test-uuid' } });
  }, async () => {
    await provider.getCart('test-uuid', { accessToken: 'real-token' });
  });
  assert.strictEqual(calls[0].pathOrUrl, '/cart/test-uuid');
  assert.strictEqual(calls[0].method, 'GET');
});

check('finaliseCart: begins checkout then finalises, extracts order id', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    if (pathOrUrl.endsWith('/checkout')) return fakeRes({ data: {} });
    if (pathOrUrl.endsWith('/finalise')) return fakeRes({ data: { order_id: 9000123 } }, { status: 202 });
    return fakeRes({});
  }, async () => {
    const result = await provider.finaliseCart('test-uuid', { user_agent: 'test' }, { accessToken: 'real-token' });
    assert.strictEqual(result.orderId, 9000123);
  });
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].pathOrUrl.endsWith('/checkout'));
  assert.ok(calls[1].pathOrUrl.endsWith('/finalise'));
  assert.deepStrictEqual(calls[1].body, { analytics: { user_agent: 'test' } });
});

// ===========================================================================
// 2. Mock round-trip — server/mock.js's v2 envelope matches the live fixture
// ===========================================================================

check('mock: fresh cart has NO stripe key at all (matches PARITY.md G3 init_empty_cart)', async () => {
  const cartData = await provider.initCart(MOCK_SESSION);
  assert.ok(cartData.uuid, 'mock cart has a uuid');
  assert.strictEqual(cartData.metadata.stripe, undefined, 'no stripe key on a fresh cart');
});

check('mock: adding a bundle line produces a PaymentIntent-shaped stripe block', async () => {
  const cartData = await provider.initCart(MOCK_SESSION);
  await provider.addBundleToCart(cartData.uuid, 792, 1, MOCK_SESSION); // bundle 792 = "CRM 5-Pack Ride Credits", £95
  const after = await provider.getCart(cartData.uuid, MOCK_SESSION);
  assert.strictEqual(after.metadata.stripe.type, 'payment');
  assert.strictEqual(after.metadata.stripe.amount, 9500);
  assert.strictEqual(after.lines.length, 1);
});

check('mock: removing the only line reverts to a zero-amount SetupIntent (matches PARITY.md G3)', async () => {
  const cartData = await provider.initCart(MOCK_SESSION);
  const line = await provider.addBundleToCart(cartData.uuid, 792, 1, MOCK_SESSION);
  await provider.removeCartLine(cartData.uuid, line.hash, MOCK_SESSION);
  const after = await provider.getCart(cartData.uuid, MOCK_SESSION);
  assert.strictEqual(after.metadata.stripe.type, 'setup');
  assert.strictEqual(after.metadata.stripe.amount, 0);
  assert.strictEqual(after.lines.length, 0);
});

check('mock: full checkout/init → confirm round trip settles Paid (dev-mode credits purchase)', async () => {
  const cartData = await provider.initCart(MOCK_SESSION);
  await provider.addBundleToCart(cartData.uuid, 792, 1, MOCK_SESSION);
  const methods = await provider.listCartPaymentMethods(MOCK_SESSION);
  assert.ok(methods.length > 0, 'mock lists saved cards');
  await provider.attachCartPaymentMethod(cartData.uuid, methods[0].id, MOCK_SESSION);
  const { orderId } = await provider.finaliseCart(cartData.uuid, {}, MOCK_SESSION);
  assert.ok(orderId, 'finalise returns an order id');
  const order = await provider.getOrder(orderId, MOCK_SESSION);
  assert.strictEqual(order.status, 'Paid');
});

// ===========================================================================
// 3. Retired v1 endpoints are gone from this module
// ===========================================================================

check('codexfit-cart.js contains no retired v1 path', () => {
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('./providers/codexfit-cart.js'), 'utf8');
  for (const pattern of ['/cart/add_bundle', 'get_payment_methods', 'ajaxCheckoutProcess']) {
    assert.ok(!src.includes(pattern), `retired pattern "${pattern}" must not appear`);
  }
});

(async () => {
  console.log('\n🧪 CodexFit v2 cart contract tests (C2-1)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.stack || err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} cart checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
