'use strict';
// Stage-only, deny-by-default broker for the JAB login + account profile flow.
const http = require('node:http');
const crypto = require('node:crypto');
const { assertAllowedProfileRequest } = require('./mcp/jab-profile-policy');

const port = Number(process.env.MCP_STAGE_JAB_GATEWAY_PORT || 3100);
let active = false;
const safePaths = new Set(['/o/authorize/', '/auth/login/', '/o/token/', '/api/customer/v1/me/account']);
const safeHeaders = new Set(['accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'referer', 'user-agent']);

function sameSecret(a, b) {
  const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function readBody(req, max, signal) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      req.off('data', onData); req.off('end', onEnd);
      signal.removeEventListener('abort', onAbort);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > max) finish(new Error('request too large')); else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAbort = () => finish(signal.reason || new Error('request cancelled'));
    const onError = error => finish(error);
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError);
    // A prematurely closed IncomingMessage can emit error after aborted. Keep
    // its error listener until close, even if the AbortSignal settled us first.
    req.once('close', () => req.off('error', onError));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
async function readResponse(response, max) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error('upstream response too large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function createServer({ gatewayKey = process.env.MCP_STAGE_JAB_GATEWAY_KEY || '', fetchImpl = fetch, deadlineMs = 15000,
  readWindow = process.env.MCP_STAGE_JAB_READ_WINDOW_FILE ? require('./mcp/jab-read-window').gatewayWindow({
    configurationFile: process.env.MCP_STAGE_JAB_READ_WINDOW_FILE, stateFile: process.env.MCP_STAGE_JAB_READ_STATE_FILE,
  }) : null } = {}) {
if (gatewayKey.length < 32) throw new Error('Stage gateway key must be at least 32 characters');
return http.createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST' || req.url !== '/profile-request' || !sameSecret(req.headers['x-stage-egress-key'], gatewayKey)) { res.writeHead(404).end(); return; }
  if (active) { res.writeHead(429).end(); return; }
  active = true;
  const started = Date.now(); let method = 'OTHER'; let path = 'unapproved'; let status = 502;
  let phase = 'request_parse'; let outcome = 'request_invalid';
  let admission;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(new Error('gateway deadline exceeded')), deadlineMs);
  const abortOnRequestAbort = () => controller.abort(new Error('gateway client disconnected'));
  const abortOnResponseClose = () => { if (!res.writableEnded) abortOnRequestAbort(); };
  req.on('aborted', abortOnRequestAbort);
  res.on('close', abortOnResponseClose);
  try {
    const raw = await readBody(req, 256 * 1024, controller.signal);
    const input = JSON.parse(raw.toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['url', 'method', 'headers', 'body'].includes(k)) || typeof input.url !== 'string' || input.url.length > 8192 || typeof input.method !== 'string' || (input.body != null && typeof input.body !== 'string') || (input.body && input.body.length > 16 * 1024)) throw new Error('invalid gateway request');
    const target = new URL(input.url);
    const requestedMethod = String(input.method || 'GET').toUpperCase();
    method = ['GET', 'POST'].includes(requestedMethod) ? requestedMethod : 'OTHER';
    if (safePaths.has(target.pathname)) path = target.pathname;
    const headers = {};
    for (const [name, value] of Object.entries(input.headers || {})) if (safeHeaders.has(name.toLowerCase()) && typeof value === 'string' && value.length <= 8192) headers[name.toLowerCase()] = value;
    phase = 'policy_validate';
    if (readWindow) admission = readWindow.admit(input.url, { method, headers, body: input.body });
    else assertAllowedProfileRequest(target, { method, headers, body: input.body });
    if (admission) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error('read window expired')), Math.max(0, Math.min(deadlineMs, admission.expiresAt - Date.now())));
    }
    phase = 'upstream_request';
    let upstream;
    let bytes;
    upstream = await fetchImpl(target, { method, headers, body: method === 'POST' ? String(input.body || '') : undefined, redirect: 'manual', signal: controller.signal });
    bytes = await readResponse(upstream, 1024 * 1024);
    controller.signal.throwIfAborted();
    if (readWindow && !readWindow.finish(admission, upstream.status, bytes)) throw new Error('read window stopped');
    const outHeaders = {};
    for (const h of ['content-type', 'location', 'set-cookie', 'www-authenticate']) {
      const v = h === 'set-cookie' && typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : upstream.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    status = upstream.status;
    outcome = 'upstream_response';
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status, headers: outHeaders, body: bytes.toString('base64') }));
    }
  } catch (err) {
    if (admission) { try { readWindow.stop(); } catch (_) { /* expiry/storage already fails closed */ } }
    if (phase === 'policy_validate') { status = 403; outcome = 'policy_denied'; }
    else if (phase === 'request_parse') { status = 400; outcome = 'request_invalid'; }
    else { status = 502; outcome = 'upstream_error'; }
    if (!res.destroyed && !res.writableEnded) {
      if (phase === 'request_parse' || !req.complete) res.setHeader('connection', 'close');
      res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":"request denied"}');
    }
  } finally {
    // No URL, query, headers, body, cookie, credential, token or upstream error is logged.
    process.stdout.write(JSON.stringify({ event: 'stage_jab_profile_hop', phase, outcome, method, path, status, durationMs: Date.now() - started }) + '\n');
    clearTimeout(timer);
    req.off('aborted', abortOnRequestAbort);
    res.off('close', abortOnResponseClose);
    active = false;
  }
}); }
if (require.main === module) createServer().listen(port, '0.0.0.0');
module.exports = { createServer };
