// Sweat Assistant — CodexFit v2 cart & checkout protocol (C2-1, 2026-09-26).
//
// This is CodexFit protocol, not policy — it belongs alongside providers/codexfit.js
// per WP-D7 (the platform module is the only thing that talks HTTP for its own
// platform). It's split into its own file purely for size: providers/codexfit.js
// codexfit.js is already large, and the cart lifecycle is a self-contained
// sub-protocol. Nothing outside providers/codexfit.js should require this file
// directly.
//
// Source of truth: server/fixtures/codexfit-v2/PARITY.md (a live capture against
// the real psyclelondon.com site, 2026-09-26) and, where the capture didn't
// reach, Documentation/Services/psycle_codexfit.md §2.5. Where the two
// disagreed, the fixture won — see PARITY.md's "CONTRADICTS-DOC" notes:
//   - An empty/just-initialized cart has NO `stripe` key in `metadata` at all
//     (the doc shows one present at init).
//   - Add-line's request body is `{"type":"bundle","id":<bundleId>}` — NO
//     `quantity` field (the doc shows one). Quantity changes go through the
//     separate increment/decrement mutation endpoint instead.
//
// UNVERIFIED against live Psycle (C2 hard rule: no purchase, ever — see
// Documentation/Workstreams/C2-psycle-api-v2.md and PARITY.md's G3 note):
// listPaymentMethods, attachPaymentMethod, beginCheckout, and finaliseCart.
// These four follow Documentation/Services/psycle_codexfit.md §2.5.3 exactly,
// but that step of the live capture was deliberately never exercised (no
// purchase was made). Flagged again at each function below and in
// C2-psycle-api-v2.md. Exercised only against server/mock.js's v2 mirror.

function cartError(message, res, data) {
  const err = new Error((data && data.message) || message);
  err.status = res.status;
  err.data = data;
  return err;
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

// POST /cart {} — initialize a new cart session. CONFIRMED live (PARITY.md G3).
async function initCart(provider, token) {
  const res = await provider.requestV2('/cart', { token, method: 'POST', body: {} });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Failed to initialize cart', res, data);
  return data.data || data;
}

// GET /cart/{uuid} — cart snapshot, including `metadata.stripe` once the cart
// has (or has had) a line. CONFIRMED live (PARITY.md G3/G7).
async function getCart(provider, token, uuid) {
  const res = await provider.requestV2(`/cart/${uuid}`, { token, method: 'GET' });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Failed to load cart', res, data);
  return data.data || data;
}

// POST /cart/{uuid}/lines {type:"bundle", id} — no `quantity` field (see
// header note). CONFIRMED live (PARITY.md G3). Returns the new line, which
// carries the `hash` needed for quantity mutation / removal.
async function addLine(provider, token, uuid, bundleId) {
  const res = await provider.requestV2(`/cart/${uuid}/lines`, {
    token, method: 'POST', body: { type: 'bundle', id: bundleId },
  });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Failed to add bundle to cart', res, data);
  return data.data || data;
}

// PUT /cart/{uuid}/lines/{hash} {hash, action: "increment"|"decrement"} —
// documented in psycle_codexfit.md §2.5.2 #4; not exercised in the live
// capture (only add + remove were), but this is the documented, low-risk way
// to reach quantity > 1 given add-line itself no longer takes a quantity.
async function mutateLineQuantity(provider, token, uuid, hash, action) {
  const res = await provider.requestV2(`/cart/${uuid}/lines/${hash}`, {
    token, method: 'PUT', body: { hash, action },
  });
  const data = await readJson(res);
  if (!res.ok) throw cartError(`Failed to ${action} cart line quantity`, res, data);
  return data.data || data;
}

// DELETE /cart/{uuid}/lines/{hash}. CONFIRMED live (PARITY.md G3).
async function removeLine(provider, token, uuid, hash) {
  const res = await provider.requestV2(`/cart/${uuid}/lines/${hash}`, { token, method: 'DELETE' });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Failed to remove cart line', res, data);
  return data;
}

// --- UNVERIFIED below this line — see header note ---------------------------

// GET /payment-methods — psycle_codexfit.md §2.5.3 #1. UNVERIFIED live.
async function listPaymentMethods(provider, token) {
  const res = await provider.requestV2('/payment-methods', { token, method: 'GET' });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Could not load saved cards', res, data);
  if (Array.isArray(data)) return data;
  return data.data || data.methods || [];
}

// POST /cart/{uuid}/payment-method {payment_method}. UNVERIFIED live.
async function attachPaymentMethod(provider, token, uuid, paymentMethodId) {
  const res = await provider.requestV2(`/cart/${uuid}/payment-method`, {
    token, method: 'POST', body: { payment_method: paymentMethodId },
  });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Failed to set payment method', res, data);
  return data.data || data;
}

// POST /cart/{uuid}/checkout {}. UNVERIFIED live.
async function beginCheckout(provider, token, uuid) {
  const res = await provider.requestV2(`/cart/${uuid}/checkout`, { token, method: 'POST', body: {} });
  const data = await readJson(res);
  if (!res.ok) throw cartError('Failed to begin checkout', res, data);
  return data.data || data;
}

// POST /cart/{uuid}/finalise {analytics}. Returns 202 Accepted per the doc;
// the caller then polls for order status. UNVERIFIED live — no purchase was
// ever made against real Psycle (C2 hard rule).
async function finaliseCart(provider, token, uuid, analytics) {
  const res = await provider.requestV2(`/cart/${uuid}/finalise`, {
    token, method: 'POST', body: { analytics: analytics || {} },
  });
  const data = await readJson(res);
  if (!res.ok && res.status !== 202) throw cartError('Checkout failed', res, data);
  return data.data || data;
}

function extractOrderId(data) {
  return (data && (data.order_id || data.orderId || (data.order && data.order.id))) || null;
}

module.exports = {
  initCart, getCart, addLine, mutateLineQuantity, removeLine,
  listPaymentMethods, attachPaymentMethod, beginCheckout, finaliseCart,
  extractOrderId,
};
