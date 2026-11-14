// New signup setup is private account state, not part of an unauthenticated install bearer.
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const assert = require('node:assert/strict');
const express = require('express');
const dbm = require('./db');
const { db } = dbm;
const auth = require('./auth');
const teams = require('./teams');
const acceptance = require('./policies').CURRENT_ACCEPTANCE;
const { router } = require('./teams-routes');
const app = express(); app.use(express.json()); app.use('/api', router);
(async () => {
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (token, invite, method = 'GET', body) => {
    const r = await fetch(`${base}/api/teams/invite/${invite}/onboarding`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json };
  };
  const recover = async (token) => {
    const r = await fetch(`${base}/api/teams/onboarding`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, headers: r.headers };
  };
  let now = Date.parse('2026-11-12T12:00:00Z'); teams.__setNow(() => now);
  try {
    const owner = await auth.handleSignup('owner@fixture.test', 'safe-password', acceptance);
    const { team, inviteToken } = teams.createTeam(owner.user.id, { name: 'Account-bound crew' });
    const install = teams.createInstallContinuation(inviteToken);
    const originalStartUrl = teams.installContinuationStartUrl(install.continuation);
    const fresh = await auth.handleSignup('new@fixture.test', 'safe-password', acceptance, { teamInviteToken: inviteToken });
    const recovered = await recover(fresh.token);
    assert.equal(recovered.status, 200, 'authenticated account must recover its pending invitation without any launch token');
    assert.deepEqual(recovered.body, { step: 'gyms', inviteToken });
    assert.match(recovered.headers.get('cache-control'), /no-store/);
    assert.equal((await recover(null)).status, 401);
    assert.equal((await auth.handleLogin('new@fixture.test', 'safe-password')).user.id, fresh.user.id, 'login must identify the Dibs account, never a gym profile or null');
    dbm.upsertUserGym(fresh.user.id, 'psycle-london', { profile_json: JSON.stringify({ id: 99999, first_name: 'Provider' }) });
    assert.equal((await auth.handleLogin('new@fixture.test', 'safe-password')).user.id, fresh.user.id, 'linked provider profile id must never replace the account id');
    assert.deepEqual(await get(fresh.token, inviteToken), { status: 200, body: { step: 'gyms' } }, 'new signup setup must survive separate browser storage');
    assert.equal(teams.installContinuationStartUrl(install.continuation), originalStartUrl, 'signup never replaces pre-existing manifest snapshot');
    assert.equal(teams.consumeInstallContinuation(install.continuation).inviteToken, inviteToken);
    assert.equal(teams.consumeInstallContinuation(install.continuation).inviteToken, null);
    console.log('PASS signup persists account-bound setup while original opaque handoff stays single-use');

    const other = await auth.handleSignup('other@fixture.test', 'safe-password', acceptance);
    assert.deepEqual((await get(other.token, inviteToken)).body, { step: null });
    assert.deepEqual((await recover(other.token)).body, { step: null, inviteToken: null });
    assert.deepEqual((await get(other.token, inviteToken, 'PUT', { step: 'features', userId: fresh.user.id })).body, { step: null });
    await get(other.token, inviteToken, 'DELETE');
    assert.deepEqual((await get(fresh.token, inviteToken)).body, { step: 'gyms' });
    assert.equal((await get(null, inviteToken)).status, 401);
    assert.deepEqual((await get(fresh.token, inviteToken, 'PUT', { step: 'name', userId: other.user.id })).body, { step: 'name' });
    assert.equal((await get(fresh.token, inviteToken, 'PUT', { step: 'intro' })).status, 400);
    assert.deepEqual((await get(fresh.token, inviteToken, 'PUT', { step: 'features' })).body, { step: 'features' });
    console.log('PASS only authenticated owner can read/update/clear its pending signup; allowed steps only');

    const old = await auth.handleSignup('plain@fixture.test', 'safe-password', acceptance);
    await get(old.token, inviteToken, 'PUT', { step: 'gyms' });
    assert.deepEqual((await get(old.token, inviteToken)).body, { step: null }, 'existing account cannot create new-signup state');
    await get(fresh.token, inviteToken, 'DELETE');
    assert.deepEqual((await recover(fresh.token)).body, { step: null, inviteToken: null }, 'completed signup never reopens from ordinary root');
    assert.deepEqual((await get(fresh.token, inviteToken)).body, { step: null });
    await get(fresh.token, inviteToken, 'PUT', { step: 'gyms' });
    assert.deepEqual((await get(fresh.token, inviteToken)).body, { step: null }, 'completion cannot be resurrected by stale progress');
    const afterRedemption = await auth.handleSignup('after-redemption@fixture.test', 'safe-password', acceptance, { teamInviteToken: inviteToken });
    assert.deepEqual((await get(afterRedemption.token, inviteToken)).body, { step: 'gyms' });
    console.log('PASS completed/existing accounts stay ordinary; signup after prior handoff redemption still persists');

    const invalid = await auth.handleSignup('invalid@fixture.test', 'safe-password', acceptance, { teamInviteToken: 'invalid' });
    assert.ok(invalid.token, 'bad/expired invite must not leave account created but signup failed');
    const rotated = await auth.handleSignup('rotated@fixture.test', 'safe-password', acceptance, { teamInviteToken: inviteToken });
    const next = teams.rotateInvite(owner.user.id, team.id).inviteToken;
    assert.deepEqual((await get(rotated.token, inviteToken)).body, { step: null });
    assert.deepEqual((await get(rotated.token, next)).body, { step: null });
    assert.deepEqual((await recover(rotated.token)).body, { step: null, inviteToken: null });
    const disabled = await auth.handleSignup('disabled@fixture.test', 'safe-password', acceptance, { teamInviteToken: next });
    teams.setInviteEnabled(owner.user.id, team.id, false);
    assert.deepEqual((await recover(disabled.token)).body, { step: null, inviteToken: null });
    teams.setInviteEnabled(owner.user.id, team.id, true);
    const expired = await auth.handleSignup('expired@fixture.test', 'safe-password', acceptance, { teamInviteToken: next });
    now += teams.INSTALL_CONTINUATION_TTL_MS;
    assert.deepEqual((await get(expired.token, next)).body, { step: null });
    assert.deepEqual((await recover(expired.token)).body, { step: null, inviteToken: null });
    console.log('PASS invalid signup context, rotated invite and 24-hour expiry do not revive setup');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM team_join_requests').get().c, 0);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM team_members').get().c, 1);
    const dump = JSON.stringify(db.prepare('SELECT * FROM team_signup_onboarding').all());
    assert.ok(!dump.includes(inviteToken)); assert.ok(!dump.includes(fresh.token));
    console.log('PASS no Team join/sharing, session bearer or raw invite is stored/transferred');
    console.log('5/5 Team signup onboarding checks passed');
  } finally { teams.__setNow(null); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
