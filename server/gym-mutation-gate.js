// Coordinate the account switch with provider mutations in this process.
// No lease is taken during read-only preparation. Once a move starts, its
// cleanup/recovery must finish before the switch reports the gym as off.
const db = require('./db');
const states = new Map();
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();
function run(userId, gymId, work) { return context.run({ userId, gymId, issued: false }, work); }
function nextAction() { const current = context.getStore(); if (current) current.issued = false; }
function beforeRequest(gymId, method) {
  const current = context.getStore();
  if (!current || current.gymId !== gymId || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
  if (!current.issued && (isClosing(current.userId, gymId) || !db.isUserGymEnabled(current.userId, gymId))) {
    const error = new Error('Gym was turned off before the provider mutation');
    error.code = 'GYM_DISABLED';
    throw error;
  }
  current.issued = true;
}
const key = (userId, gymId) => `${userId}:${gymId}`;
function begin(userId, gymId) {
  const k = key(userId, gymId);
  const state = states.get(k) || { active: 0, closing: false, waiters: [] };
  if (state.closing || !db.isUserGymEnabled(userId, gymId)) return null;
  state.active++;
  states.set(k, state);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.active === 0) {
      for (const resolve of state.waiters.splice(0)) resolve();
      if (!state.closing) states.delete(k);
    }
  };
}
async function disable(userId, gymId) {
  const k = key(userId, gymId);
  const state = states.get(k) || { active: 0, closing: false, waiters: [] };
  state.closing = true;
  const disabledAt = new Date().toISOString();
  states.set(k, state);
  try {
    if (state.active) await new Promise(resolve => state.waiters.push(resolve));
    return db.setUserGymEnabled(userId, gymId, false, disabledAt);
  } finally {
    state.closing = false;
    if (!state.active) states.delete(k);
  }
}
function isClosing(userId, gymId) { return !!states.get(key(userId, gymId))?.closing; }
module.exports = { begin, disable, isClosing, run, nextAction, beforeRequest };
