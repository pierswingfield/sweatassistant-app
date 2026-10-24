// Optional transport accounting boundary. Normal PWA/background work is never
// charged to an MCP account and does not inherit MCP's lower-priority limits.
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const accounts = new Map();
const gyms = new Set();
const limited = () => Object.assign(new Error('MCP concurrency limit reached'), { code: 'RATE_LIMITED', status: 429, retryAfter: 1 });
const current = () => storage.getStore();
async function run({ identity, scope, gymId, providerReads, signal }, fn) {
  const store = require('./store');
  const actor = store.authorize(identity, scope, gymId);
  const key = `${actor.userId}:${gymId || ''}`;
  if ((accounts.get(actor.userId) || 0) >= 2 || (gymId && gyms.has(key))) throw limited();
  accounts.set(actor.userId, (accounts.get(actor.userId) || 0) + 1);
  if (gymId) gyms.add(key);
  const controller = new AbortController();
  const disconnect = () => controller.abort(Object.assign(new Error('Tool request cancelled'), { code: 'DEADLINE_EXCEEDED' }));
  if (signal?.aborted) disconnect();
  else signal?.addEventListener('abort', disconnect, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Tool deadline exceeded'), { code: 'DEADLINE_EXCEEDED' })), 12000);
  const state = { identity, actor, scope, gymId, providerReads, controller, active: true, attempts: 0 };
  try {
    return await storage.run(state, async () => {
      const result = await new Promise((resolve, reject) => {
        const abort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) { abort(); return; }
        controller.signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(fn(actor)).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
      });
      if (controller.signal.aborted) throw Object.assign(new Error('Tool deadline exceeded'), { code: 'DEADLINE_EXCEEDED' });
      store.authorize(identity, scope, gymId);
      return result;
    });
  } finally {
    signal?.removeEventListener('abort', disconnect);
    state.active = false;
    controller.abort();
    clearTimeout(timer);
    accounts.set(actor.userId, accounts.get(actor.userId) - 1);
    if (!accounts.get(actor.userId)) accounts.delete(actor.userId);
    if (gymId) gyms.delete(key);
  }
}
// Bound one tool's existing parallel pagination without introducing a shared
// waiting queue. Every queued hop rechecks deadline, grant and budgets on entry.
async function withProviderSlot(fn) {
  const state = current();
  if (!state) return fn();
  if ((state.queued || 0) >= 6) throw limited();
  state.queued = (state.queued || 0) + 1;
  const previous = state.providerTail;
  let release;
  state.providerTail = new Promise(resolve => { release = resolve; });
  try {
    if (previous) await previous;
    if (!state.active || state.controller.signal.aborted) throw Object.assign(new Error('Tool request cancelled'), { code: 'DEADLINE_EXCEEDED' });
    return await fn();
  } finally { state.queued--; release(); }
}
function admitProvider(gymId, method, purpose) {
  const state = current();
  if (!state) return undefined;
  const store = require('./store');
  if (!state.active || state.controller.signal.aborted || !state.providerReads || (method !== 'GET' && purpose !== 'credential') || gymId !== state.gymId) {
    throw Object.assign(new Error('Provider work is not permitted'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  }
  store.authorize(state.identity, state.scope, gymId);
  const backoff = require('../rate-limit-backoff');
  if (backoff.isGymRateLimited(gymId)) throw limited();
  if (++state.attempts > 6) throw limited();
  store.charge([
    [`provider:user:${state.actor.userId}:${gymId}`, 6, 60000],
    [`provider:daily:${state.actor.userId}`, 200, 86400000],
    [`provider:gym:${gymId}`, 30, 60000],
    ['provider:fleet', 60, 60000],
  ]);
  return state.controller.signal;
}
module.exports = { current, run, admitProvider, withProviderSlot };
