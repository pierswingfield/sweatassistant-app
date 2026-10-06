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
async function timedProviderFetch(gymId, method, pathOrUrl, doFetch) {
  const start = Date.now();
  const outcomeOf = (st) => (st === 429 ? '429' : st >= 400 || st == null ? 'error' : 'ok');
  const count = (st) => {
    try {
      const g = require('./gyms.config').getGymConfig(gymId);
      require('./metrics').observeProvider(gymId, g ? g.provider : 'unknown', outcomeOf(st));
    } catch (_) {}
  };
  const path = String(pathOrUrl).replace(/^https?:\/\/[^/]+/i, '').split('?')[0];
  try {
    const res = await doFetch();
    count(res && res.status);
    log.debug('provider call', { gymId, method, path, status: res && res.status, durationMs: Date.now() - start });
    return res;
  } catch (err) {
    count(null);
    log.debug('provider call failed', { gymId, method, path, durationMs: Date.now() - start, err });
    throw err;
  }
}

module.exports = { createLogger, requestLogger, timedProviderFetch, log, redact };
