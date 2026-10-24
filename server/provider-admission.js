// One single-instance upstream boundary. Fixed limits are operational safety
// policy, not claims about any gym's quotas. No queue and no mutation retries.
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const active = new Set();
const lanes = new Set(['scheduler', 'interactive', 'background']);
const current = () => storage.getStore();
function run(actor, fn) {
  if (!lanes.has(actor.lane)) throw new Error('Invalid provider lane');
  return storage.run({ lane: actor.lane, userId: actor.userId }, fn);
}
function runForUser(userId, fn) {
  return run({ lane: current()?.lane || 'background', userId }, fn);
}
function enabled() {
  return process.env.PROVIDER_ADMISSION_ENABLED === 'true' ||
    (process.env.MCP_ENABLED === 'true' && process.env.MCP_PROVIDER_READS_ENABLED === 'true') ||
    !!require('./mcp/context').current();
}
const rejected = (code = 'RATE_LIMITED', status = 429) => Object.assign(new Error(code === 'RATE_LIMITED' ? 'Provider capacity unavailable; retry later' : 'Provider deadline exceeded'), { code, status, retryAfter: 1 });
function actor() {
  const mcp = require('./mcp/context').current();
  return mcp ? { lane: 'mcp', userId: mcp.actor.userId } : (current() || { lane: 'background', userId: 'unattributed' });
}
// Non-scheduler has a smaller ceiling; optional traffic has a smaller one again.
// Reservations apply to rate AND concurrency. A scheduler GET is still critical.
function dimensions(a, gymId) {
  const optional = a.lane === 'background' || a.lane === 'mcp';
  const total = [ ['fleet', 120, 12], [`gym:${gymId}`, 90, 8], [`account:${a.userId}`, 60, 6] ];
  const result = total.map(([key, rate, concurrency]) => ({ key, rate, concurrency, match: () => true }));
  if (a.lane !== 'scheduler') {
    result.push(...total.map(([key, rate, concurrency]) => ({ key: `normal:${key}`, rate: key.startsWith('account:') ? 30 : rate - 30, concurrency: concurrency - (key === 'fleet' ? 4 : key.startsWith('gym:') ? 2 : 1), match: x => x.lane !== 'scheduler' })));
  }
  if (optional) {
    result.push(...total.map(([key, rate, concurrency]) => ({ key: `optional:${key}`, rate: key.startsWith('account:') ? 12 : rate - 60, concurrency: key === 'fleet' ? 4 : key.startsWith('gym:') ? 3 : 2, match: x => x.lane === 'background' || x.lane === 'mcp' })));
  }
  return result;
}
function admit(gymId) {
  if (!enabled()) return null;
  const a = actor();
  if (require('./rate-limit-backoff').isGymRateLimited(gymId)) throw rejected();
  const dims = dimensions(a, gymId);
  for (const d of dims) {
    const scope = d.key.replace(/^(normal|optional):/, '');
    const count = [...active].filter(x => d.match(x) && (scope === 'fleet' || (scope.startsWith('gym:') ? x.gymId === gymId : x.userId === a.userId))).length;
    if (count >= d.concurrency) throw rejected();
  }
  require('./mcp/store').charge([
    ...dims.map(d => [`common:${d.key}`, d.rate, 60000]),
    [`common:daily:account:${a.userId}`, 1000, 86400000],
    ['common:daily:fleet', 10000, 86400000],
    ...(a.lane !== 'scheduler' ? [[`common:daily:normal:account:${a.userId}`, 700, 86400000], ['common:daily:normal:fleet', 7000, 86400000]] : []),
    ...(a.lane === 'background' || a.lane === 'mcp' ? [[`common:daily:optional:account:${a.userId}`, 400, 86400000], ['common:daily:optional:fleet', 4000, 86400000]] : []),
  ]);
  const entry = { ...a, gymId };
  active.add(entry);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(rejected('DEADLINE_EXCEEDED', 504)), 10000);
  let released = false;
  return { signal: controller.signal, release() { if (released) return; released = true; clearTimeout(timer); active.delete(entry); } };
}
function flightScope() {
  if (!enabled()) return 'shared';
  const a = actor();
  return a.lane === 'mcp' ? `mcp:${a.userId}` : a.lane;
}
function observe(lane, result) {
  require('./metrics').observeAdmission(lane, result);
}
module.exports = { flightScope, runForUser, run, current, enabled, actor, admit, observe };
