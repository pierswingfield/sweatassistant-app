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
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > max) { reject(new Error('request too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readResponse(response, max) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > max) throw new Error('upstream response too large'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function createServer({ gatewayKey = process.env.MCP_STAGE_JAB_GATEWAY_KEY || '', fetchImpl = fetch, deadlineMs = 15000 } = {}) {
if (gatewayKey.length < 32) throw new Error('Stage gateway key must be at least 32 characters');
return http.createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST' || req.url !== '/profile-request' || !sameSecret(req.headers['x-stage-egress-key'], gatewayKey)) { res.writeHead(404).end(); return; }
  if (active) { res.writeHead(429).end(); return; }
  active = true;
  const started = Date.now(); let method = 'OTHER'; let path = 'unapproved'; let status = 502;
  let phase = 'request_parse'; let outcome = 'request_invalid';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('gateway deadline exceeded')), deadlineMs);
  const abortOnRequestAbort = () => controller.abort(new Error('gateway client disconnected'));
  const abortOnResponseClose = () => { if (!res.writableEnded) abortOnRequestAbort(); };
  req.on('aborted', abortOnRequestAbort);
  res.on('close', abortOnResponseClose);
  try {
    const raw = await readBody(req, 256 * 1024);
    const input = JSON.parse(raw.toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['url', 'method', 'headers', 'body'].includes(k)) || typeof input.url !== 'string' || input.url.length > 8192 || typeof input.method !== 'string' || (input.body != null && typeof input.body !== 'string') || (input.body && input.body.length > 16 * 1024)) throw new Error('invalid gateway request');
    const target = new URL(input.url);
    const requestedMethod = String(input.method || 'GET').toUpperCase();
    method = ['GET', 'POST'].includes(requestedMethod) ? requestedMethod : 'OTHER';
    if (safePaths.has(target.pathname)) path = target.pathname;
    const headers = {};
    for (const [name, value] of Object.entries(input.headers || {})) if (safeHeaders.has(name.toLowerCase()) && typeof value === 'string' && value.length <= 8192) headers[name.toLowerCase()] = value;
    phase = 'policy_validate';
    assertAllowedProfileRequest(target, { method, headers, body: input.body });
    phase = 'upstream_request';
    let upstream;
    let bytes;
    upstream = await fetchImpl(target, { method, headers, body: method === 'POST' ? String(input.body || '') : undefined, redirect: 'manual', signal: controller.signal });
    bytes = await readResponse(upstream, 1024 * 1024);
    controller.signal.throwIfAborted();
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
    if (phase === 'policy_validate') { status = 403; outcome = 'policy_denied'; }
    else if (phase === 'request_parse') { status = 400; outcome = 'request_invalid'; }
    else { status = 502; outcome = 'upstream_error'; }
    if (!res.destroyed && !res.writableEnded) res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":"request denied"}');
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
