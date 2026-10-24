const fs = require('node:fs');
const store = require('./store');
function verifier(config) {
  // Operator-owned local public keys: no attacker-controlled discovery/JWKS URLs.
  const jwks = JSON.parse(fs.readFileSync(config.jwksFile, 'utf8'));
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 10 || jwks.keys.some(k =>
    !['RSA', 'EC'].includes(k.kty) || k.d || k.k || (k.use && k.use !== 'sig'))) throw new Error('MCP JWKS must contain public signing keys only');
  let resolver;
  return async function verify(token) {
    if (typeof token !== 'string' || token.length > 8192) throw new Error('Invalid bearer token');
    const jose = await import('jose');
    resolver ||= jose.createLocalJWKSet(jwks);
    const { payload: p } = await jose.jwtVerify(token, resolver, {
      issuer: config.issuer, audience: config.resource, algorithms: ['RS256', 'ES256'], typ: 'at+jwt',
      requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'client_id', 'jti', 'sa_grant_id', 'scope'],
      maxTokenAge: '15m', clockTolerance: 0,
    });
    if (p.aud !== config.resource || typeof p.iat !== 'number' || p.iat > Date.now() / 1000 || p.exp <= p.iat || p.exp - p.iat > 900 ||
        typeof p.sub !== 'string' || !p.sub || p.sub.length > 200 || typeof p.client_id !== 'string' || p.client_id.length > 200 ||
        typeof p.sa_grant_id !== 'string' || p.sa_grant_id.length > 100 || typeof p.scope !== 'string' || p.scope.length > 200 ||
        typeof p.jti !== 'string' || !p.jti || p.jti.length > 200) throw new Error('Invalid access token claims');
    const identity = Object.freeze({ issuer: p.iss, subject: p.sub, clientId: p.client_id,
      grantId: p.sa_grant_id, scopes: Object.freeze(p.scope.split(' ').filter(Boolean)), expiresAt: p.exp * 1000 });
    store.authorize(identity);
    return identity;
  };
}
module.exports = { verifier };
