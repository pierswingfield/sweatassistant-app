'use strict';
// Opt-in staging acceptance only. Private configuration is shared with the app;
// the gateway alone owns the durable, fail-closed six-attempt ledger.
const fs = require('node:fs');
const crypto = require('node:crypto');
const HOST = 'jabboxingclub.marianatek.com';
const PREFIX = '/api/customer/v1';
const denied = () => Object.assign(new Error('Staging read window does not permit this request'), { code: 'PROVIDER_WORK_DISABLED', status: 403 });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function privateJson(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || stat.mode & 0o077) throw denied();
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function configuration(file, now = Date.now()) {
  const c = privateJson(file);
  if (!c || Object.keys(c).sort().join() !== 'accountId,authorizationHash,day,expiresAt,startsAt,windowId' ||
      !/^[a-zA-Z0-9_-]{16,100}$/.test(c.windowId) || !Number.isSafeInteger(c.accountId) || c.accountId < 1 ||
      !/^[a-f0-9]{64}$/.test(c.authorizationHash) || !/^\d{4}-\d{2}-\d{2}$/.test(c.day) ||
      new Date(c.day).toISOString().slice(0, 10) !== c.day || !Number.isSafeInteger(c.startsAt) || !Number.isSafeInteger(c.expiresAt) ||
      c.expiresAt <= c.startsAt || c.expiresAt - c.startsAt > 120000 || now < c.startsAt || now >= c.expiresAt) throw denied();
  return c;
}
function assertRequest(c, url, options = {}, eventId) {
  const u = new URL(url), method = options.method || 'GET';
  // Reject alternate URL spellings before URL normalization can erase them.
  if (String(url) !== u.href || /%|\\/.test(String(url)) || u.protocol !== 'https:' || u.hostname !== HOST ||
      u.port || u.username || u.password || u.hash || method !== 'GET' || options.body != null ||
      digest(new Headers(options.headers || {}).get('authorization') || '') !== c.authorizationHash) throw denied();
  const p = u.pathname, q = u.searchParams;
  if ((p === `${PREFIX}/me/credits` || p === `${PREFIX}/classes/${eventId}` && eventId) && !u.search) return 'read';
  if (p === `${PREFIX}/me/reservations` && u.search === '?is_upcoming=true&page_size=100') return 'read';
  if (p === `${PREFIX}/classes` && u.search === `?min_start_date=${c.day}&max_start_date=${c.day}&page_size=100` &&
      [...q].length === 3) return 'classes';
  throw denied();
}
function permitsActor(file, actor, tool, now) {
  try { return actor.userId === configuration(file, now).accountId && ['search_classes', 'get_class_details', 'get_my_bookings', 'get_credits'].includes(tool); }
  catch (_) { return false; }
}
function gatewayWindow({ configurationFile, stateFile, now = Date.now }) {
  if (!configurationFile || !stateFile) throw denied();
  function transaction(fn) {
    // A crashed process leaves this lock behind: operator review is required,
    // rather than silently resetting an allowance after restart or a bad write.
    const lock = fs.openSync(`${stateFile}.lock`, 'wx', 0o600);
    try {
      const c = configuration(configurationFile, now()), configHash = digest(JSON.stringify(c));
      let state;
      try { state = privateJson(stateFile); }
      catch (e) { if (e.code !== 'ENOENT') throw e; state = { configHash, count: 0, stopped: false, eventId: null }; }
      if (state.configHash !== configHash || !Number.isInteger(state.count) || state.count < 0 || state.count > 6 ||
          typeof state.stopped !== 'boolean' || state.eventId !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(state.eventId)) throw denied();
      const result = fn(c, state);
      const temp = `${stateFile}.${crypto.randomBytes(12).toString('hex')}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, stateFile);
        const dir = fs.openSync(require('node:path').dirname(stateFile), fs.constants.O_RDONLY);
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch (_) { /* renamed */ } }
      return result;
    } finally { fs.closeSync(lock); fs.unlinkSync(`${stateFile}.lock`); }
  }
  return {
    admit(url, options) {
      return transaction((c, s) => {
        if (s.stopped || s.count >= 6) throw denied();
        const kind = assertRequest(c, url, options, s.eventId);
        s.count++; // Persist before transport; failures and cancellation are not refunded.
        return { kind, expiresAt: c.expiresAt };
      });
    },
    finish(admission, status, bytes) {
      return transaction((_c, s) => {
        if (status !== 200) { s.stopped = true; return false; }
        if (admission.kind === 'classes') {
          let body; try { body = JSON.parse(bytes.toString('utf8')); } catch (_) { s.stopped = true; return false; }
          if (!Array.isArray(body.results) || Number(body.meta?.pagination?.pages || 1) !== 1 || body.next || body.links?.next) { s.stopped = true; return false; }
          const id = body.results[0]?.id;
          if (id != null && !/^[a-zA-Z0-9_-]{1,100}$/.test(String(id))) { s.stopped = true; return false; }
          if (id != null && !s.eventId) s.eventId = String(id);
        }
        return !s.stopped;
      });
    },
    stop() { transaction((_c, s) => { s.stopped = true; }); },
  };
}
module.exports = { configuration, assertRequest, permitsActor, gatewayWindow };
