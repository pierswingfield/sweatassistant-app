// C7-3 step 2: tiny structured logger. One JSON line per event:
//   {"ts","level","msg", ...context}   (userId, gymId, route, durationMs, ...)
// LOG_LEVEL = debug|info|warn|error (default info). LOG_PRETTY=1 indents for humans.
// Secrets are redacted by KEY NAME, and Errors are reduced to their message (no stack).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /pass(word)?|token|secret|jwt|authorization|cookie|api[-_]?key/i;

function redact(v, depth = 0) {
  if (v instanceof Error) return v.message;
  if (v === null || typeof v !== 'object') return v;
  if (depth > 4) return '[depth]';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(val, depth + 1);
  return out;
}

const defaultWrite = (level, line) => (level === 'error' || level === 'warn' ? console.error : console.log)(line);

function createLogger({ level = process.env.LOG_LEVEL, write = defaultWrite, base = {}, pretty = process.env.LOG_PRETTY === '1' } = {}) {
  const min = LEVELS[String(level || 'info').toLowerCase()] || LEVELS.info;
  const emit = (lvl, msg, ctx) => {
    if (LEVELS[lvl] < min) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg: String(msg), ...redact({ ...base, ...(ctx || {}) }) };
    let line;
    try { line = JSON.stringify(rec, null, pretty ? 2 : 0); } catch (_) { line = JSON.stringify({ ts: rec.ts, level: lvl, msg: rec.msg }); }
    write(lvl, line);
  };
  const log = { child: (ctx) => createLogger({ level, write, pretty, base: { ...base, ...ctx } }) };
  for (const l of Object.keys(LEVELS)) log[l] = (msg, ctx) => emit(l, msg, ctx);
  return log;
}

// Calendar feed URLs carry a bearer-like token in the path.
function scrubPath(p) { return p.replace(/^(\/api\/calendar\/)[^/]+(\.ics)$/, '$1:token$2'); }

// Method, path (no query string), status, duration, userId when authenticated. Nothing else:
// never bodies, headers or query strings. Static asset hits and health probes log at debug.
function requestLogger(log) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const path = scrubPath((req.originalUrl || req.url || '').split('?')[0]);
      const noisy = !path.startsWith('/api/') || path === '/api/health';
      const ctx = { method: req.method, path, status: res.statusCode, durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10 };
      if (req.userId != null) ctx.userId = req.userId;
      log[noisy ? 'debug' : 'info']('request', ctx);
    });
    next();
  };
}

const log = createLogger();

// Debug-level line per upstream provider call (gymId, method, path without query, status, durationMs),
// so the number of upstream /events calls behind one request is countable: LOG_LEVEL=debug.
function timedProviderFetch(...args) {
  return require('./mcp/context').withProviderSlot(() => performProviderFetch(...args));
}
async function performProviderFetch(gymId, method, pathOrUrl, doFetch, purpose) {
  const start = Date.now();
  const outcomeOf = (st) => (st === 429 ? '429' : st >= 400 || st == null ? 'error' : 'ok');
  const count = (st) => {
    try {
      const g = require('./gyms.config').getGymConfig(gymId);
      require('./metrics').observeProvider(gymId, g ? g.provider : 'unknown', outcomeOf(st));
      require('./metrics').observeMcpWork('provider_calls', outcomeOf(st));
    } catch (_) {}
  };
  const path = String(pathOrUrl).replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
  const admission = require('./provider-admission');
  let lease;
  let attempted = false;
  const lane = admission.actor().lane;
  try {
    const mcpSignal = require('./mcp/context').admitProvider(gymId, method, purpose);
    lease = admission.admit(gymId);
    const signals = [mcpSignal, lease?.signal].filter(Boolean);
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    attempted = true;
    let res = await abortable(doFetch(signal), signal);
    require('./rate-limit-backoff').noteThrottleResponse(gymId, res);
    // Keep the reservation through the complete body, with bounded memory and
    // deadline. Otherwise slow bodies evade concurrency after headers arrive.
    if (lease && res?.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await abortable(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) throw Object.assign(new Error('Provider response exceeds limit'), { code: 'PROVIDER_RESPONSE_TOO_LARGE', status: 502 });
          chunks.push(Buffer.from(value));
        }
      } catch (err) { reader.cancel().catch(() => {}); throw err; }
      res = new Response(Buffer.concat(chunks), { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    if (signal) signal.throwIfAborted();
    admission.observe(lane, 'admitted');
    count(res && res.status);
    log.debug('provider call', { gymId, method, path, status: res && res.status, durationMs: Date.now() - start });
    return res;
  } catch (err) {
    admission.observe(lane, err.code === 'RATE_LIMITED' ? 'rejected' : 'error');
    if (attempted) count(null);
    log.debug('provider call failed', { gymId, method, path, durationMs: Date.now() - start, err });
    throw err;
  } finally { lease?.release(); }
}

// Abort races bound even a stalled custom/mock response stream; native fetch also
// receives the signal so the socket is cancelled, not just its caller.
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Provider request aborted'));
    if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function credentialProviderFetch(gymId, url, options = {}) {
  const gym = require('./gyms.config').getGymConfig(gymId);
  const target = new URL(url);
  if (require('./mcp/stage-profile-only').enabled()) {
    if (!require('./mcp/stage-profile-only').permitsProvider(gym)) throw Object.assign(new Error('Provider access is disabled in stage profile-only mode'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
    const { assertAllowedProfileRequest } = require('./mcp/jab-profile-policy');
    assertAllowedProfileRequest(target, options);
    const gateway = process.env.MCP_STAGE_JAB_GATEWAY_URL;
    const key = process.env.MCP_STAGE_JAB_GATEWAY_KEY;
    if (!gateway || !key) throw Object.assign(new Error('Stage profile gateway is not configured'), { code: 'PROVIDER_WORK_DISABLED', status: 503 });
    return timedProviderFetch(gymId, options.method || 'GET', target.pathname, async signal => {
      const headers = new Headers(options.headers || {});
      const body = options.body == null ? null : String(options.body);
      const signals = [signal, options.signal].filter(Boolean);
      const response = await fetch(gateway.replace(/\/$/, '') + '/profile-request', {
        method: 'POST', redirect: 'manual', ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
        headers: { 'content-type': 'application/json', 'x-stage-egress-key': key },
        body: JSON.stringify({ url: target.toString(), method: options.method || 'GET', headers: Object.fromEntries(headers), body }),
      });
      const payload = await response.json();
      const responseHeaders = { ...(payload.headers || {}) };
      const cookies = responseHeaders['set-cookie']; delete responseHeaders['set-cookie'];
      const result = new Response(Buffer.from(payload.body || '', 'base64'), { status: payload.status, headers: responseHeaders });
      if (Array.isArray(cookies)) result.headers.getSetCookie = () => cookies;
      else if (cookies) result.headers.set('set-cookie', cookies);
      return result;
    }, 'credential');
  }
  const origins = [gym?.apiBaseUrl, gym?.oauthBaseUrl].filter(Boolean).map(value => new URL(value).origin);
  if (target.username || target.password || !origins.includes(target.origin)) {
    throw Object.assign(new Error('Gym authentication redirect is not permitted'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
  }
  return timedProviderFetch(gymId, options.method || 'GET', url,
    signal => fetch(url, { ...(require('./provider-admission').enabled() ? { redirect: 'manual' } : {}), ...options, ...(signal ? { signal } : {}) }), 'credential');
}
module.exports = { credentialProviderFetch, createLogger, requestLogger, timedProviderFetch, log, redact };
