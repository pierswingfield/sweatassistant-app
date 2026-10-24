const express = require('express');
const crypto = require('node:crypto');
const { configuration, SCOPES } = require('./config');
// Mounted before the PWA JSON parser/CORS; its smaller limit cannot be bypassed.
function mountMcp(app, config = configuration()) {
  const metadataPath = '/.well-known/oauth-protected-resource/mcp';
  if (!config.enabled) {
    app.all(['/mcp', metadataPath], (_req, res) => res.status(404).json({ code: 'NOT_FOUND' }));
    return;
  }
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { verifier } = require('./auth');
  const store = require('./store');
  const { catalog, registerTools } = require('./tools');
  const verify = verifier(config);
  const router = express.Router();
  const metadata = new URL(metadataPath, config.resource).href;
  function challenge(res, error, scope) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadata}"${error ? `, error="${error}"` : ''}${scope ? `, scope="${scope}"` : ''}`);
  }
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.headers.host !== config.host || (req.headers.origin && !config.origins.includes(req.headers.origin))) return res.status(403).json({ code: 'INVALID_ORIGIN_OR_HOST' });
    if (req.headers.origin) {
      res.set('Access-Control-Allow-Origin', req.headers.origin);
      res.vary('Origin');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, Retry-After');
    }
    try {
      // Proxy must preserve Host and provide a trusted client IP before a pilot.
      const ip = crypto.createHash('sha256').update(req.ip || req.socket.remoteAddress || 'unknown').digest('hex');
      store.charge([[`ip:${ip}`, 120, 60000]]);
    } catch (err) { return budgetError(res, err); }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
      return res.sendStatus(204);
    }
    next();
  });
  router.get(metadataPath, (_req, res) => res.json({ resource: config.resource,
    authorization_servers: [config.issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'] }));
  router.use('/mcp', async (req, res, next) => {
    if (Object.keys(req.query).length) return res.status(400).json({ code: 'QUERY_PARAMETERS_FORBIDDEN' });
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization || '');
    if (!match) { challenge(res); return res.status(401).json({ code: 'UNAUTHORIZED' }); }
    try { req.mcpIdentity = await verify(match[1]); }
    catch (_) { challenge(res, 'invalid_token'); return res.status(401).json({ code: 'UNAUTHORIZED' }); }
    const actor = store.authorize(req.mcpIdentity);
    try {
      store.charge([[`requests:user:${actor.userId}`, 60, 60000], [`requests:grant:${actor.grantId}`, 40, 60000],
        [`requests:client:${actor.userId}:${actor.clientId}`, 40, 60000], [`requests:daily:${actor.userId}`, 1000, 86400000]]);
    } catch (err) { return budgetError(res, err); }
    next();
  });
  router.post('/mcp', express.json({ limit: '16kb', strict: true }), async (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || !['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'].includes(body.method)) return res.status(400).json({ code: 'UNSUPPORTED_REQUEST' });
    if (req.headers['mcp-session-id'] || req.headers['last-event-id']) return res.status(400).json({ code: 'SESSIONS_UNSUPPORTED' });
    if (body.method === 'initialize' ? body.params?.protocolVersion !== '2025-11-25' : req.headers['mcp-protocol-version'] !== '2025-11-25') {
      return res.status(400).json({ code: 'UNSUPPORTED_PROTOCOL', supported: ['2025-11-25'] });
    }
    if (body.method === 'tools/call') {
      const toolName = body.params?.name;
      const def = typeof toolName === 'string' && Object.hasOwn(catalog, toolName) ? catalog[toolName] : null;
      if (!def || (def.upstream && !config.providerReads)) return res.status(400).json({ code: 'UNKNOWN_TOOL' });
      const parsed = def.schema.safeParse(body.params?.arguments ?? {});
      if (!parsed.success) return res.status(400).json({ code: 'INVALID_ARGUMENTS' });
      try { store.authorize(req.mcpIdentity, def.scope, parsed.data.gymId); }
      catch (err) {
        if (err.code === 'INSUFFICIENT_SCOPE') challenge(res, 'insufficient_scope', def.scope);
        return res.status(403).json({ code: err.code });
      }
    }
    const server = new McpServer({ name: 'gym-assistant-mcp', version: '0.1.0' });
    registerTools(server, req.mcpIdentity, config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 16384 });
    const close = () => { server.close().catch(() => {}); };
    res.once('close', close);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (_) {
      if (!res.headersSent) res.status(500).json({ code: 'MCP_UNAVAILABLE' });
    }
  });
  router.all('/mcp', (_req, res) => res.set('Allow', 'POST, OPTIONS').status(405).json({ code: 'METHOD_NOT_ALLOWED' }));
  router.use((err, _req, res, _next) => res.status(err.type === 'entity.too.large' ? 413 : 400).json({ code: err.type === 'entity.too.large' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON' }));
  app.use((req, res, next) => {
    if (req.path === '/mcp' || req.path === metadataPath) return router(req, res, next);
    next();
  });
}
function budgetError(res, err) {
  const limited = err.code === 'RATE_LIMITED';
  if (limited) res.set('Retry-After', String(err.retryAfter || 1));
  return res.status(limited ? 429 : 503).json({ code: limited ? 'RATE_LIMITED' : 'BUDGET_UNAVAILABLE' });
}
module.exports = { mountMcp };
