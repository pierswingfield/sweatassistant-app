// MCP is an isolated, opt-in OAuth resource server. No dynamic metadata fetch.
const SCOPES = Object.freeze(['schedule:read', 'account:read', 'automation:read', 'bookings:write']);
function configuration(env = process.env) {
  if (env.MCP_ENABLED !== 'true') return { enabled: false };
  const canonical = (name) => {
    const raw = env[name];
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error(`${name} must be an absolute HTTPS URL`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== raw) {
      throw new Error(`${name} must be a canonical HTTPS URL without credentials, query or fragment`);
    }
    return url;
  };
  const resource = canonical('MCP_RESOURCE_URL');
  if (resource.pathname !== '/mcp') throw new Error('MCP_RESOURCE_URL must end in /mcp');
  const issuer = canonical('MCP_ISSUER');
  if (!env.MCP_JWKS_FILE) throw new Error('MCP_JWKS_FILE is required');
  return {
    enabled: true, resource: resource.href, issuer: issuer.href,
    jwksFile: env.MCP_JWKS_FILE, host: resource.host,
    origins: [resource.origin], providerReads: env.MCP_PROVIDER_READS_ENABLED === 'true',
    writesEnabled: env.MCP_WRITES_ENABLED === 'true',
    stageReadWindowFile: env.MCP_STAGE_JAB_PROFILE_ONLY === 'true' ? env.MCP_STAGE_JAB_READ_WINDOW_FILE : undefined,
  };
}
module.exports = { configuration, SCOPES };
