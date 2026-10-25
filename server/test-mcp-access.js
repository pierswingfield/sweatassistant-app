// Access policy/admin HTTP and per-account execution fixtures. No provider traffic.
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
process.env.ADMIN_PASSWORD = 'offline-fixture-admin';
process.env.JWT_SECRET = 'offline-fixture-signing-key';
process.env.JAB_BOXING_ENABLED = 'true';
const assert = require('node:assert/strict');
const express = require('express');
const db = require('./db');
const store = require('./mcp/store');
const context = require('./mcp/context');
(async () => {
  const app = express(); app.use(express.json()); app.use('/api/admin', require('./admin'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const call = async (method, path, body, token) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/admin${path}`, { method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    const uid = db.createAccount('mcp-access@example.test', 'offline-password');
    const other = db.createAccount('mcp-other@example.test', 'offline-password');
    const gyms = db.getGyms().filter(g => g.enabled).slice(0, 2).map(g => g.id);
    assert.equal(gyms.length, 2);
    for (const g of gyms) { db.linkGym(uid, g); db.linkGym(other, g); }
    store.registerClient('access-fixture', 'Access fixture');
    const grant = (userId, gymIds = gyms) => store.createGrant({ userId, issuer: 'https://fixture.test/', subject: `user:${userId}`,
      clientId: 'access-fixture', scopes: ['account:read'], gymIds, expiresAt: Date.now() + 3600000, consentReference: 'offline-fixture' });
    const identity = (userId, grantId) => ({ issuer: 'https://fixture.test/', subject: `user:${userId}`, clientId: 'access-fixture',
      grantId, scopes: ['account:read'], expiresAt: Date.now() + 3600000 });
    const id = identity(uid, grant(uid)); const otherId = identity(other, grant(other));
    const narrow = identity(uid, grant(uid, [gyms[0]]));
    const token = (await call('POST', '/login', { password: process.env.ADMIN_PASSWORD })).body.token;
    assert.equal((await call('GET', `/users/${uid}/mcp-access`, undefined, token)).status, 200, 'admin account MCP policy route exists');
    assert.equal((await call('GET', `/users/${uid}/mcp-access`)).status, 401);
    assert.deepEqual((await call('GET', `/users/${uid}/mcp-access`, undefined, token)).body, { enabled: true });
    assert.equal((await call('PUT', `/users/${uid}/mcp-access`, { enabled: 'false' }, token)).status, 400);
    assert.equal((await call('PUT', '/users/999999/mcp-access', { enabled: false }, token)).status, 404);
    assert.equal((await call('PUT', `/users/${uid}/mcp-access`, { enabled: false }, token)).status, 200);
    assert.throws(() => store.authorize(id), e => e.code === 'ACCESS_DENIED');
    assert.throws(() => grant(uid), e => e.code === 'ACCESS_DENIED');
    assert.equal(store.authorize(otherId).userId, other);
    assert.equal((await call('PUT', `/users/${uid}/mcp-access`, { enabled: true }, token)).status, 200);
    assert.equal(store.authorize(id).userId, uid, 'admin override does not revoke/widen existing grant');
    await call('PUT', `/gyms/${gyms[0]}/mcp-access`, { enabled: false }, token);
    assert.deepEqual(store.authorize(id).gyms, [gyms[1]]);
    assert.throws(() => store.authorize(id, 'account:read', gyms[0]), e => e.code === 'ACCESS_DENIED');
    assert.throws(() => grant(uid, [gyms[0]]), e => e.code === 'ACCESS_DENIED');
    await call('PUT', `/gyms/${gyms[0]}/mcp-access`, { enabled: true }, token);
    assert.deepEqual(store.authorize(narrow).gyms, [gyms[0]], 'new product default cannot widen a limited grant');
    const fresh = db.createAccount('future-mcp@example.test', 'offline-password');
    assert.deepEqual((await call('GET', `/users/${fresh}/mcp-access`, undefined, token)).body, { enabled: true });
    let release;
    const held = context.run({ identity: id, scope: 'account:read', gymId: gyms[0], providerReads: false }, () => new Promise(r => { release = r; }));
    await assert.rejects(() => context.run({ identity: id, scope: 'account:read', gymId: gyms[1], providerReads: false }, async () => {}), e => e.code === 'RATE_LIMITED');
    await context.run({ identity: otherId, scope: 'account:read', gymId: gyms[1], providerReads: false }, async () => {});
    await call('PUT', `/users/${uid}/mcp-access`, { enabled: false }, token);
    release({ mustNotEscape: true });
    await assert.rejects(() => held, e => e.code === 'ACCESS_DENIED');
    await call('PUT', `/users/${uid}/mcp-access`, { enabled: true }, token);
    await context.run({ identity: id, scope: 'account:read', gymId: gyms[1], providerReads: false }, async () => {});
    const slots = require('./mcp/request-slot');
    const { EventEmitter } = require('node:events');
    const first = new EventEmitter(), next = new EventEmitter(), independent = new EventEmitter();
    slots.acquire(uid, first);
    assert.throws(() => slots.acquire(uid, new EventEmitter()), e => e.code === 'RATE_LIMITED');
    slots.acquire(other, independent); independent.emit('finish');
    first.emit('close');
    assert.equal(first.listenerCount('finish'), 0);
    slots.acquire(uid, next);
    first.emit('finish'); // an old response cannot free a newer reservation
    assert.throws(() => slots.acquire(uid, new EventEmitter()), e => e.code === 'RATE_LIMITED');
    next.emit('finish');
    assert.equal(next.listenerCount('close'), 0);
    assert.ok(db.listAdminAudit({ limit: 100 }).some(r => r.action === 'mcp.account-access'));
    assert.ok(db.listAdminAudit({ limit: 100 }).some(r => r.action === 'mcp.gym-access'));
    console.log('MCP account/gym access and cross-gym serialization fixtures passed');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
