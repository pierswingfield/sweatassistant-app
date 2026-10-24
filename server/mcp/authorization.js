// Maintained OAuth protocol engine; this module supplies application policy and
// durable model hooks. It never accepts a gym password or an external identity.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const OAuth = require('@node-oauth/oauth2-server');
const db = require('../db');
const store = require('./store');
const { SCOPES } = require('./config');
const { appName } = require('../config');
const { log } = require('../logger');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const fingerprint = id => hash(db.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(id)?.password_hash || '');
const fail = () => new OAuth.InvalidGrantError('Authorization is no longer valid');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scopeLabels = { 'schedule:read': 'Read class timetables and class details', 'account:read': 'Read your bookings and credits', 'automation:read': 'Read your existing automations' };
const COOKIE = '__Host-sa-mcp';

function loadAuthorizationConfiguration(config, env = process.env) {
  if (env.MCP_AUTH_SERVER_ENABLED !== 'true') return null;
  if (!config.enabled || config.issuer !== new URL('/', config.resource).href) throw new Error('Local MCP issuer must be the resource origin with a trailing slash');
  const signingJwk = JSON.parse(fs.readFileSync(env.MCP_SIGNING_KEY_FILE, 'utf8'));
  if (!['RSA', 'EC'].includes(signingJwk.kty) || !signingJwk.d || !signingJwk.kid || !['RS256', 'ES256'].includes(signingJwk.alg)) throw new Error('MCP signing key must be an identified private RS256 or ES256 JWK');
  const publicKey = crypto.createPublicKey(crypto.createPrivateKey({ key: signingJwk, format: 'jwk' })).export({ format: 'der', type: 'spki' });
  const keys = JSON.parse(fs.readFileSync(config.jwksFile, 'utf8')).keys;
  if (!keys.some(k => k.kid === signingJwk.kid && !k.d && publicKey.equals(crypto.createPublicKey({ key: k, format: 'jwk' }).export({ format: 'der', type: 'spki' })))) throw new Error('MCP signing key does not match resource verification keys');
  const clients = JSON.parse(fs.readFileSync(env.MCP_CLIENTS_FILE, 'utf8')).clients;
  if (!Array.isArray(clients) || !clients.length || clients.length > 10) throw new Error('Configure 1–10 preregistered MCP clients');
  const ids = new Set();
  for (const c of clients) {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) || ids.has(c.id) || typeof c.name !== 'string' || !c.name.length || c.name.length > 100 ||
        !Array.isArray(c.redirectUris) || !c.redirectUris.length || c.redirectUris.length > 5 ||
        !(c.public === true && !c.secretHash || c.public === false && /^[a-f0-9]{64}$/.test(c.secretHash))) throw new Error('Invalid preregistered MCP client');
    ids.add(c.id);
    for (const uri of c.redirectUris) {
      const u = new URL(uri);
      if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.href !== uri || uri.length > 2048) throw new Error('MCP callbacks must be exact canonical HTTPS URLs');
    }
    const existing = db.db.prepare('SELECT name FROM mcp_clients WHERE client_id = ?').get(c.id);
    if (existing && existing.name !== c.name) throw new Error('Registered client name differs from persisted identity');
    if (!existing) store.registerClient(c.id, c.name);
  }
  return { ...config, signingJwk, clients };
}

function createAuthorizationModel(config) {
  const grant = id => db.db.prepare('SELECT * FROM mcp_grants WHERE id = ?').get(id);
  function userFor(id) {
    const g = grant(id);
    if (!g) throw fail();
    const user = { id: g.user_id, grantId: g.id };
    try { store.authorize({ issuer: g.issuer, subject: g.subject, clientId: g.client_id, grantId: g.id, scopes: JSON.parse(g.scopes_json), expiresAt: g.expires_at }); }
    catch (_) { throw fail(); }
    return user;
  }
  const clientById = id => config.clients.find(c => c.id === id);
  const model = {
    getClient(id, secret) {
      const c = clientById(id);
      if (!c || !db.db.prepare('SELECT 1 FROM mcp_clients WHERE client_id = ? AND disabled_at IS NULL').get(id)) return false;
      // null is the library's authorization lookup. undefined is an unauthenticated token request.
      if (secret !== null && !(c.public ? !secret : typeof secret === 'string' && secret.length <= 1024 && crypto.timingSafeEqual(Buffer.from(hash(secret)), Buffer.from(c.secretHash)))) return false;
      return { id, grants: ['authorization_code', 'refresh_token'], redirectUris: c.redirectUris };
    },
    validateScope(user, client, scopes) {
      const g = grant(user.grantId);
      const allowed = g && JSON.parse(g.scopes_json);
      return g && g.client_id === client.id && Array.isArray(scopes) && scopes.length && scopes.every(s => SCOPES.includes(s) && allowed.includes(s)) ? scopes : false;
    },
    saveAuthorizationCode(code, client, user) {
      userFor(user.grantId);
      db.db.prepare('INSERT INTO mcp_oauth_codes (token_hash, grant_id, data_json, expires_at) VALUES (?, ?, ?, ?)')
        .run(hash(code.authorizationCode), user.grantId, JSON.stringify({ redirectUri: code.redirectUri, scope: code.scope, codeChallenge: code.codeChallenge, codeChallengeMethod: code.codeChallengeMethod }), +code.expiresAt);
      return { ...code, client, user };
    },
    getAuthorizationCode(value) {
      const row = db.db.prepare('SELECT * FROM mcp_oauth_codes WHERE token_hash = ?').get(hash(value));
      if (!row || row.consumed_at || row.expires_at <= Date.now()) return false;
      const user = userFor(row.grant_id);
      return { ...JSON.parse(row.data_json), authorizationCode: value, expiresAt: new Date(row.expires_at), user, client: model.getClient(grant(row.grant_id).client_id, null) };
    },
    revokeAuthorizationCode(code) {
      return db.db.prepare('UPDATE mcp_oauth_codes SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL').run(Date.now(), hash(code.authorizationCode)).changes === 1;
    },
    async generateAccessToken(client, user, scopes) {
      userFor(user.grantId);
      const jose = await import('jose');
      const key = await jose.importJWK(config.signingJwk, config.signingJwk.alg);
      const g = grant(user.grantId);
      return new jose.SignJWT({ client_id: client.id, sa_grant_id: g.id, scope: scopes.join(' ') })
        .setProtectedHeader({ alg: config.signingJwk.alg, kid: config.signingJwk.kid, typ: 'at+jwt' })
        .setIssuer(config.issuer).setSubject(g.subject).setAudience(config.resource).setIssuedAt().setExpirationTime('10m').setJti(random()).sign(key);
    },
    getRefreshToken(value) {
      const row = db.db.prepare('SELECT * FROM mcp_oauth_refresh WHERE token_hash = ?').get(hash(value));
      if (!row) return false;
      // Keep consumed hashes until family expiry: a replay kills all descendants.
      if (row.consumed_at) {
        db.db.prepare('UPDATE mcp_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(Date.now(), row.grant_id);
        log.warn('MCP refresh replay; grant revoked', { grantId: row.grant_id });
        return false;
      }
      if (row.expires_at <= Date.now()) return false;
      const user = userFor(row.grant_id);
      return { refreshToken: value, refreshTokenExpiresAt: new Date(row.expires_at), scope: JSON.parse(row.scope_json), user, client: model.getClient(grant(row.grant_id).client_id, null) };
    },
    revokeToken(token) {
      const consumed = db.db.prepare('UPDATE mcp_oauth_refresh SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL').run(Date.now(), hash(token.refreshToken)).changes === 1;
      if (!consumed) store.revokeGrant(token.user.id, token.user.grantId);
      return consumed;
    },
    saveToken(token, client, user) {
      userFor(user.grantId); // catches revocation/replay racing with signing
      const g = grant(user.grantId);
      const expires = Math.min(+token.refreshTokenExpiresAt, g.expires_at);
      db.db.prepare('INSERT INTO mcp_oauth_refresh (token_hash, grant_id, scope_json, expires_at) VALUES (?, ?, ?, ?)')
        .run(hash(token.refreshToken), user.grantId, JSON.stringify(token.scope), expires);
      return { ...token, refreshTokenExpiresAt: new Date(expires), client, user };
    },
  };
  return model;
}

function mountAuthorization(app, resourceConfig, options = {}) {
  const config = options.config || loadAuthorizationConfiguration(resourceConfig);
  if (!config) return;
  const origin = new URL(config.resource).origin;
  const model = createAuthorizationModel(config);
  const oauth = new OAuth({ model, accessTokenLifetime: 600, refreshTokenLifetime: 30 * 86400,
    authorizationCodeLifetime: 60, requirePKCE: true, enablePlainPKCE: false,
    requireClientAuthentication: { authorization_code: false, refresh_token: false }, alwaysIssueNewRefreshToken: true });
  const router = express.Router();
  const asyncRoute = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  function clean() {
    const now = Date.now();
    db.db.prepare('DELETE FROM mcp_oauth_interactions WHERE expires_at <= ?').run(now);
    db.db.prepare('DELETE FROM mcp_oauth_codes WHERE expires_at <= ?').run(now);
    db.db.prepare('DELETE FROM mcp_oauth_refresh WHERE expires_at <= ?').run(now);
    db.db.prepare('DELETE FROM mcp_grants WHERE expires_at <= ? OR revoked_at <= ?').run(now - 30 * 864e5, now - 30 * 864e5);
  }
  // Retention also runs when there are no new OAuth requests. One process only.
  const retentionTimer = setInterval(clean, 15 * 60000);
  retentionTimer.unref();
  router.use((req, res, next) => {
    // no-referrer makes browser navigation POSTs send Origin: null. same-origin
    // preserves first-party CSRF checks while suppressing cross-origin referrers.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (req.headers.host !== config.host || req.headers.origin && req.headers.origin !== origin) return res.status(403).json({ error: 'access_denied' });
    try { store.charge([[`oauth:ip:${hash(req.ip || req.socket.remoteAddress || 'unknown')}`, 100, 60000]]); clean(); }
    catch (_) { return res.status(429).set('Retry-After', '60').json({ error: 'temporarily_unavailable' }); }
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 30 }));
  function page(res, title, body, status = 200) {
    return res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(appName)}</title><link rel="stylesheet" href="/oauth/styles.css"></head><body><main class="mcp-page"><p>${escape(appName)}</p><h1>${escape(title)}</h1>${body}</main></body></html>`);
  }
  const hidden = tx => `<input type="hidden" name="interaction" value="${escape(tx.id)}"><input type="hidden" name="csrf" value="${escape(tx.csrf)}">`;
  function login(res, tx, message = '') {
    return page(res, 'Sign in to your account', `<p>Use your ${escape(appName)} account password.</p>${message ? `<p role="alert">${escape(message)}</p>` : ''}<form method="post" action="/oauth/login">${hidden(tx)}<label>Email<input type="email" name="email" autocomplete="username" required maxlength="254"></label><label>Password<input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label><button type="submit">Sign in</button></form><a href="/">Back to the app</a>`);
  }
  function begin(res, request) {
    const tx = { id: random(), csrf: random() };
    const cookie = random();
    db.db.prepare('INSERT INTO mcp_oauth_interactions (id, cookie_hash, csrf, request_json, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tx.id, hash(cookie), tx.csrf, JSON.stringify(request), Date.now() + 10 * 60000);
    res.cookie(COOKIE, cookie, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 10 * 60000 });
    return login(res, tx);
  }
  function interaction(req, loggedIn = false) {
    const id = req.body.interaction;
    if (typeof id !== 'string' || typeof req.body.csrf !== 'string' || req.headers.origin !== origin) throw fail();
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const tx = db.db.prepare('SELECT * FROM mcp_oauth_interactions WHERE id = ? AND consumed_at IS NULL AND expires_at > ?').get(id, Date.now());
    if (!tx || !cookie || hash(cookie) !== tx.cookie_hash || tx.csrf !== req.body.csrf || loggedIn && (!tx.user_id || fingerprint(tx.user_id) !== tx.account_fingerprint)) throw fail();
    return tx;
  }
  function consent(res, tx) {
    const request = JSON.parse(tx.request_json);
    const client = config.clients.find(c => c.id === request.client_id);
    // Chrome checks form-action across the code redirect as well as the POST.
    // Only this immutable preregistered callback origin is added on consent.
    res.set('Content-Security-Policy', `default-src 'none'; style-src 'self'; form-action 'self' ${new URL(request.redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    const gyms = db.getUserGyms(tx.user_id).filter(g => g.status !== 'disabled' && db.getGym(g.gym_id)?.enabled);
    return page(res, `Connect ${client.name}`, `<p>Choose what this AI client may read and which gyms it may access. Access expires in 30 days. You can revoke it at any time in AI connections.</p><p>No booking, cancellation, purchase or automation changes are permitted.</p><form method="post" action="/oauth/consent">${hidden(tx)}<fieldset><legend>Permissions</legend>${request.scope.split(' ').map(s => `<label><input type="checkbox" name="scopes" value="${escape(s)}">${escape(scopeLabels[s])}</label>`).join('')}</fieldset><fieldset><legend>Gyms</legend>${gyms.map(g => `<label><input type="checkbox" name="gyms" value="${escape(g.gym_id)}">${escape(db.getGym(g.gym_id).name)}</label>`).join('') || '<p>Connect a gym in the app before granting access.</p>'}</fieldset><button name="decision" value="allow" type="submit">Allow selected access</button><button name="decision" value="deny" type="submit">Deny</button></form>`);
  }
  function connections(res, tx, message = '') {
    const clients = new Map(config.clients.map(c => [c.id, c.name]));
    const rows = store.listGrants(tx.user_id).filter(g => !g.revoked_at && g.expires_at > Date.now());
    return page(res, 'AI connections', `<p>Each connection can only read its selected permissions and gyms. Revoke access immediately, including refresh tokens.</p>${message ? `<p role="status">${escape(message)}</p>` : ''}${rows.map(g => `<section><h2>${escape(clients.get(g.client_id) || g.client_id)}</h2><p>${JSON.parse(g.scopes_json).map(s => escape(scopeLabels[s])).join('; ')}</p><p>Gyms: ${JSON.parse(g.gyms_json).map(v => escape(db.getGym(v.gymId)?.name || v.gymId)).join(', ')}</p><p>Expires: ${escape(new Date(g.expires_at).toISOString())}<br>Last used: ${g.last_used_at ? escape(new Date(g.last_used_at).toISOString()) : 'Not yet used'}</p><form method="post" action="/oauth/connections/revoke">${hidden(tx)}<input type="hidden" name="grant" value="${escape(g.id)}"><button type="submit">Revoke ${escape(clients.get(g.client_id) || g.client_id)}</button></form></section>`).join('') || '<p>No active AI connections.</p>'}${rows.length ? `<form method="post" action="/oauth/connections/revoke">${hidden(tx)}<input type="hidden" name="grant" value="all"><button type="submit">Revoke all AI connections</button></form>` : ''}<a href="/">Back to the app</a>`);
  }
  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({ issuer: config.issuer, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], scopes_supported: SCOPES,
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'] }));
  router.get('/oauth/styles.css', (_req, res) => {
    const publicDir = process.env.PUBLIC_DIR ? path.resolve(process.env.PUBLIC_DIR) : path.join(__dirname, '../public');
    const assets = path.join(publicDir, 'assets');
    const css = fs.existsSync(assets) && fs.readdirSync(assets).find(f => /^index-[\w-]+\.css$/.test(f));
    res.sendFile(css ? path.join(assets, css) : path.join(__dirname, '../../client/src/styles.css'));
  });
  router.get('/oauth/authorize', (req, res) => {
    const q = req.query;
    const client = config.clients.find(c => c.id === q.client_id);
    if (Object.keys(q).some(k => !['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'resource', 'code_challenge', 'code_challenge_method'].includes(k)) ||
      Object.values(q).some(v => typeof v !== 'string' || v.length > 2048) || !client || !model.getClient(client.id, null) || !client.redirectUris.includes(q.redirect_uri) ||
      q.response_type !== 'code' || q.resource !== config.resource || !q.state || !/^[\x21-\x7e]{16,512}$/.test(q.state) || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || '') ||
      typeof q.scope !== 'string' || !q.scope.length || q.scope.split(' ').some(s => !SCOPES.includes(s)) || new Set(q.scope.split(' ')).size !== q.scope.split(' ').length) return page(res, 'Connection request rejected', '<p>The client request is invalid. Return to the AI client and try again.</p>', 400);
    return begin(res, { ...q, type: 'authorize' });
  });
  router.get('/oauth/connections', (_req, res) => begin(res, { type: 'connections' }));
  router.post('/oauth/login', (req, res) => {
    const tx = interaction(req);
    try { store.charge([[`oauth:login:ip:${hash(req.ip || req.socket.remoteAddress || 'unknown')}`, 10, 15 * 60000], [`oauth:login:account:${hash(String(req.body.email || '').trim().toLowerCase())}`, 10, 15 * 60000]]); }
    catch (_) { return page(res, 'Try again later', '<p>Too many sign-in attempts. Please wait 15 minutes.</p>', 429); }
    const { email, password } = req.body;
    const user = typeof email === 'string' && email.length <= 254 && db.getUserByEmail(email.trim().toLowerCase());
    if (!user || typeof password !== 'string' || password.length > 1024 || !db.verifyAccountPassword(user.id, password)) return login(res, tx, 'Invalid email or password');
    tx.user_id = user.id; tx.account_fingerprint = fingerprint(user.id); tx.csrf = random();
    db.db.prepare('UPDATE mcp_oauth_interactions SET user_id = ?, account_fingerprint = ?, csrf = ? WHERE id = ?').run(user.id, tx.account_fingerprint, tx.csrf, tx.id);
    return JSON.parse(tx.request_json).type === 'connections' ? connections(res, tx) : consent(res, tx);
  });
  router.post('/oauth/consent', asyncRoute(async (req, res) => {
    const tx = interaction(req, true);
    const request = JSON.parse(tx.request_json);
    if (request.type !== 'authorize') throw fail();
    if (req.body.decision !== 'allow' && req.body.decision !== 'deny') throw fail();
    const selected = v => Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
    const scopes = selected(req.body.scopes); const gymIds = selected(req.body.gyms);
    if (req.body.decision === 'allow' && (!scopes.length || scopes.some(s => !request.scope.split(' ').includes(s)) || !gymIds.length)) return page(res, 'Choose access', '<p>Select at least one permission and gym. Return to your AI client to begin again.</p>', 400);
    if (db.db.prepare('UPDATE mcp_oauth_interactions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(Date.now(), tx.id).changes !== 1) throw fail();
    if (req.body.decision === 'deny') {
      const callback = new URL(request.redirect_uri); callback.searchParams.set('error', 'access_denied'); callback.searchParams.set('state', request.state); return res.redirect(303, callback.href);
    }
    const grantId = store.createGrant({ userId: tx.user_id, issuer: config.issuer, subject: `account:${tx.user_id}`, clientId: request.client_id, scopes, gymIds,
      expiresAt: Date.now() + 30 * 864e5, consentReference: tx.id });
    log.info('MCP consent approved', { userId: tx.user_id, clientId: request.client_id, grantId, scopes, gymIds });
    const oauthRequest = new OAuth.Request({ method: 'GET', headers: {}, query: { ...request, scope: scopes.join(' ') }, body: {} });
    const response = new OAuth.Response();
    try {
      await oauth.authorize(oauthRequest, response, { authenticateHandler: { handle: () => ({ id: tx.user_id, grantId }) } });
      return res.redirect(303, response.headers.location);
    } catch (_) { store.revokeGrant(tx.user_id, grantId); return page(res, 'Connection failed', '<p>Return to your AI client and try again.</p>', 400); }
  }));
  router.post('/oauth/connections/revoke', (req, res) => {
    const tx = interaction(req, true);
    if (JSON.parse(tx.request_json).type !== 'connections' || typeof req.body.grant !== 'string') throw fail();
    if (req.body.grant === 'all') store.revokeAll(tx.user_id); else store.revokeGrant(tx.user_id, req.body.grant);
    log.info('MCP connection revoked', { userId: tx.user_id, grantId: req.body.grant });
    return connections(res, tx, 'Access revoked.');
  });
  router.post('/oauth/token', asyncRoute(async (req, res) => {
    if (Object.keys(req.query).length || Object.values(req.body).some(v => typeof v !== 'string') || req.body.resource !== config.resource ||
      !['authorization_code', 'refresh_token'].includes(req.body.grant_type)) return res.status(400).json({ error: 'invalid_request' });
    const request = new OAuth.Request(req); const response = new OAuth.Response();
    try { await oauth.token(request, response); }
    catch (_) { /* Library populates only its protocol error response. */ }
    res.set(response.headers).status(response.status || 200).json(response.body || { error: 'server_error' });
  }));
  router.use((err, _req, res, _next) => page(res, 'Request rejected', '<p>This request has expired or is invalid. Return to the app or AI client and start again.</p>', err.type === 'entity.too.large' ? 413 : 400));
  app.use((req, res, next) => req.path.startsWith('/oauth/') || req.path === '/.well-known/oauth-authorization-server' ? router(req, res, next) : next());
  return { oauth, model };
}
module.exports = { mountAuthorization, createAuthorizationModel, loadAuthorizationConfiguration };
