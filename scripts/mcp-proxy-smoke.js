#!/usr/bin/env node
// Read-only deployment acceptance probes. Never prints tokens or response bodies.
// Run after authorized staging setup; no gym credentials or writes are involved.
const assert = require('node:assert/strict');
(async () => {
  const resource = new URL(process.argv[2]);
  assert.equal(resource.protocol, 'https:');
  assert.equal(resource.pathname, '/mcp');
  assert.ok(!resource.username && !resource.password && !resource.search && !resource.hash);
  const probe = async (path, options = {}) => fetch(new URL(path, resource), { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const metadata = await probe('/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadata.status, 200, 'protected resource discovery');
  const data = await metadata.json();
  assert.equal(data.resource, resource.href);
  assert.deepEqual(data.authorization_servers, [`${resource.origin}/`]);
  const oauth = await probe('/.well-known/oauth-authorization-server');
  assert.equal(oauth.status, 200, 'authorization discovery');
  const as = await oauth.json();
  assert.equal(as.issuer, `${resource.origin}/`);
  assert.ok(as.code_challenge_methods_supported.includes('S256'));
  const unauthenticated = await probe('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(unauthenticated.status, 401, 'proxy must preserve bearer challenge');
  assert.ok(unauthenticated.headers.get('www-authenticate')?.includes('resource_metadata='));
  const hostile = await probe('/mcp', { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(hostile.status, 403, 'proxy must preserve Origin');
  console.log('MCP HTTPS discovery/challenge/Origin probes passed. Named-client OAuth and device acceptance remain separate.');
})().catch(() => { console.error('MCP proxy acceptance failed. Inspect staging configuration without exposing credentials.'); process.exitCode = 1; });
