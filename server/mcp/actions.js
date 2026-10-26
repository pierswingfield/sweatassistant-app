// Durable immediate-action state machine. An action ID is not approval: only a
// locally authenticated, CSRF-protected first-party decision can approve it.
const crypto = require('node:crypto');
const db = require('../db');
const access = require('./access');
const store = require('./store');
const mutations = require('../normalized-mutations');
const reads = require('../normalized-reads');
const fail = (code = 'ACTION_CHANGED') => Object.assign(new Error('Action is unavailable or requires fresh approval'), { code, status: 409 });
const encode = value => JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const row = id => db.db.prepare('SELECT * FROM mcp_actions WHERE id=?').get(id);
function gate(identity, gymId, config) {
  if (!config.writesEnabled || !config.providerReads) throw fail('WRITES_DISABLED');
  const actor = store.authorize(identity, 'bookings:write', gymId);
  store.authorize(identity, 'account:read', gymId);
  store.authorize(identity, 'schedule:read', gymId);
  const preference = access.writePreference(actor.userId);
  if (!preference.enabled) throw fail('WRITES_DISABLED');
  const ctx = db.runWithGymContext(actor.userId, gymId, () => reads.resolveContext(actor.userId));
  return { actor, binding: encode({ preference: preference.revision, account: access.policyVersion('account', actor.userId),
    gym: access.policyVersion('gym', gymId), link: ctx.linkId, session: digest(ctx.session.accessToken), accountAuth: ctx.fingerprint }) };
}
function owned(identity, id, config, inspection = false) {
  const action = row(id);
  if (!action || action.grant_id !== identity.grantId || action.client_id !== identity.clientId) throw fail();
  const current = gate(identity, action.gym_id, config);
  const sameLink = JSON.parse(current.binding).link === JSON.parse(action.binding_json).link;
  if (action.user_id !== current.actor.userId || (inspection ? !sameLink : current.binding !== action.binding_json)) throw fail();
  return action;
}
function validInput(operation, input, requestId) {
  const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
  const fields = operation === 'book' ? ['eventId', 'slotId'] : operation === 'edit' ? ['bookingId', 'currentSlotId', 'slotId'] : operation === 'cancel' ? ['bookingId'] : [];
  if (!fields.length || typeof input !== 'object' || !input || Object.keys(input).some(k => !fields.includes(k)) ||
      Object.entries(input).some(([, v]) => !identifier(v)) ||
      (operation === 'book' ? !identifier(input.eventId) : !identifier(input.bookingId)) ||
      operation === 'edit' && (!identifier(input.slotId) || !identifier(input.currentSlotId)) ||
      typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw fail('INVALID_ACTION');
  return Object.fromEntries(fields.filter(k => input[k] !== undefined).map(k => [k, input[k]]));
}
function status(action) {
  return { actionId: action.id, state: action.state, expiresAt: new Date(action.expires_at).toISOString(),
    ...(action.result_json ? { result: JSON.parse(action.result_json) } : {}) };
}
async function prepare(identity, gymId, operation, input, requestId, config) {
  input = validInput(operation, input, requestId);
  const { actor } = gate(identity, gymId, config);
  const old = db.db.prepare('SELECT * FROM mcp_actions WHERE user_id=? AND client_id=? AND request_id=?').get(actor.userId, identity.clientId, requestId);
  if (old) {
    owned(identity, old.id, config);
    if (old.operation !== operation || old.gym_id !== gymId || old.input_json !== encode(input)) throw fail('IDEMPOTENCY_CONFLICT');
    return { ...status(old), approvalUrl: `${new URL(config.resource).origin}/oauth/actions/${old.id}`, summary: JSON.parse(old.summary_json) };
  }
  const currentLink = db.getUserGym(actor.userId, gymId)?.id;
  const uncertain = db.db.prepare("SELECT binding_json FROM mcp_actions WHERE user_id=? AND gym_id=? AND state IN ('executing','unknown')").all(actor.userId, gymId);
  if (uncertain.some(r => JSON.parse(r.binding_json).link === currentLink)) throw fail('ACTION_UNCERTAIN');
  const summary = await db.runWithGymContext(actor.userId, gymId, () => mutations.describeAction(actor.userId, operation, input));
  const { binding } = gate(identity, gymId, config);
  const id = crypto.randomUUID(), expiresAt = Math.min(Date.now() + 5 * 60000, identity.expiresAt);
  if (expiresAt <= Date.now()) throw fail();
  db.db.transaction(() => {
    const pending = db.db.prepare("SELECT count(*) n FROM mcp_actions WHERE user_id=? AND state IN ('prepared','approved') AND expires_at>?").get(actor.userId, Date.now()).n;
    if (pending >= 5) throw fail('ACTION_LIMIT');
    db.db.prepare(`INSERT INTO mcp_actions(id,user_id,client_id,grant_id,request_id,gym_id,operation,identity_json,input_json,binding_json,summary_json,state,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(id, actor.userId, identity.clientId, identity.grantId, requestId, gymId, operation,
      encode({ issuer: identity.issuer, subject: identity.subject, clientId: identity.clientId, grantId: identity.grantId, scopes: identity.scopes, expiresAt }), encode(input), binding, encode(summary), Date.now(), expiresAt);
  })();
  return { ...status(row(id)), approvalUrl: `${new URL(config.resource).origin}/oauth/actions/${id}`, summary };
}
function forApproval(userId, id, config) {
  const action = row(id);
  if (!action || action.user_id !== userId || action.expires_at <= Date.now() || action.state !== 'prepared') throw fail();
  owned(JSON.parse(action.identity_json), id, config);
  return { ...status(action), summary: JSON.parse(action.summary_json) };
}
function decide(userId, id, allow, config) {
  return db.db.transaction(() => {
    forApproval(userId, id, config);
    if (db.db.prepare("UPDATE mcp_actions SET state=? WHERE id=? AND user_id=? AND state='prepared' AND expires_at>?")
      .run(allow ? 'approved' : 'denied', id, userId, Date.now()).changes !== 1) throw fail();
    return status(row(id));
  })();
}
function checkedExecuting(identity, id, config) {
  const action = owned(identity, id, config);
  if (action.state !== 'executing' || action.expires_at <= Date.now()) throw fail();
  return action;
}
async function execute(identity, id, config, gymId) {
  let action = owned(identity, id, config);
  if (gymId !== undefined && action.gym_id !== gymId) throw fail();
  if (['succeeded', 'failed', 'unknown', 'denied'].includes(action.state)) return status(action);
  if (action.state === 'executing') return status(action); // Never resend, including after restart.
  if (action.state !== 'approved') throw fail('ACTION_APPROVAL_REQUIRED');
  if (action.expires_at <= Date.now()) throw fail();
  const input = JSON.parse(action.input_json);
  const summary = await db.runWithGymContext(action.user_id, action.gym_id, () => mutations.describeAction(action.user_id, action.operation, input));
  action = owned(identity, id, config);
  if (action.summary_json !== encode(summary)) throw fail();
  if (db.db.prepare("UPDATE mcp_actions SET state='executing',claimed_at=? WHERE id=? AND state='approved' AND expires_at>?")
    .run(Date.now(), id, Date.now()).changes !== 1) return status(owned(identity, id, config));
  const context = require('./context').current();
  if (!context) { // Only authenticated MCP execution may install transport write authorization.
    db.db.prepare("UPDATE mcp_actions SET state='failed' WHERE id=? AND state='executing'").run(id);
    throw fail();
  }
  context.writeAttempts = 0;
  context.writeAuthorization = gym => {
    const current = checkedExecuting(identity, id, config);
    if (gym !== current.gym_id) throw fail();
  };
  try {
    checkedExecuting(identity, id, config);
    const result = await db.runWithGymContext(action.user_id, action.gym_id, () =>
      action.operation === 'book' ? mutations.book(action.user_id, { eventId: input.eventId, slotIds: input.slotId ? [input.slotId] : [] }, { retryAuth: false, existingCreditOnly: true }) :
      action.operation === 'edit' ? mutations.swap(action.user_id, { bookingId: input.bookingId, currentSlotId: input.currentSlotId, targetSlotId: input.slotId }, { atomicOnly: true, retryAuth: false }) :
      mutations.cancel(action.user_id, { bookingId: input.bookingId }, { singleOnly: true, retryAuth: false }));
    const safe = { ok: result?.ok === true, ...(result?.bookingId != null ? { bookingId: String(result.bookingId).slice(0, 100) } : {}),
      ...(result?.slotId != null ? { slotId: String(result.slotId).slice(0, 100) } : {}) };
    // An unclassified provider refusal can follow an uncertain mutation. Never
    // return it to the approved state or retry it as a new provider request.
    const refused = result?.ok === false && [400,401,403,404,405,409,422].includes(result.status);
    db.db.prepare("UPDATE mcp_actions SET state=?,result_json=? WHERE id=? AND state='executing'")
      .run(safe.ok ? 'succeeded' : refused ? 'failed' : 'unknown', encode(safe), id);
  } catch (error) {
    const blocked = context.writeAttempts === 0 && ['WRITES_DISABLED','ACTION_CHANGED','ACCESS_DENIED','INSUFFICIENT_SCOPE','PROVIDER_WORK_DISABLED','RATE_LIMITED'].includes(error.code);
    db.db.prepare("UPDATE mcp_actions SET state=? WHERE id=? AND state='executing'").run(blocked ? 'failed' : 'unknown', id);
  } finally {
    delete context.writeAuthorization;
    delete context.writeAttempts;
    require('../private-read-cache').invalidateGym(action.gym_id);
  }
  return status(row(id));
}
async function inspect(identity, id, config, gymId) {
  let action = owned(identity, id, config, true);
  if (gymId !== undefined && action.gym_id !== gymId) throw fail();
  // A crashed/hung execution is uncertain, never a fresh executable approval.
  if (action.state === 'executing' && action.claimed_at < Date.now() - 30000) {
    db.db.prepare("UPDATE mcp_actions SET state='unknown' WHERE id=? AND state='executing'").run(id);
    action = row(id);
  }
  if (action.state !== 'unknown') return status(action);
  // Reconciliation is read-only and conservative. Existing or ambiguous rows
  // cannot be treated as proof that this particular action succeeded.
  const summary = JSON.parse(action.summary_json), input = JSON.parse(action.input_json);
  if (Date.parse(summary.startAt) <= Date.now()) return status(action);
  const { bookings } = await db.runWithGymContext(action.user_id, action.gym_id, () => reads.bookings(action.user_id));
  owned(identity, id, config, true);
  let match;
  if (action.operation === 'book') {
    const candidates = bookings.filter(b => !b.isGuest && String(b.eventId) === summary.eventId &&
      !summary.existingBookingIds.includes(String(b.bookingId)) && (b.slotId == null ? null : String(b.slotId)) === (input.slotId || null));
    if (candidates.length === 1) match = { bookingId: String(candidates[0].bookingId) };
  } else if (action.operation === 'edit') {
    const b = bookings.find(b => String(b.bookingId) === input.bookingId);
    if (b && String(b.slotId) === input.slotId) match = { bookingId: input.bookingId, slotId: input.slotId };
  } else if (!bookings.some(b => String(b.bookingId) === input.bookingId)) match = { bookingId: input.bookingId };
  if (match) {
    db.db.prepare("UPDATE mcp_actions SET state='succeeded',result_json=? WHERE id=? AND state='unknown'").run(encode({ ok: true, reconciled: true, ...match }), id);
  }
  return status(row(id));
}
module.exports = { prepare, execute, inspect, forApproval, decide, gate };
