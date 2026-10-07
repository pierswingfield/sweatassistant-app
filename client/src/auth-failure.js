// C1-2: one gym's dead session must not log the whole app out.
//
// The server sends exactly one 401 on an authenticated request today: a
// linked gym's OWN session has died (routes-normalized.js `resolveContext`,
// or a failed relogin in auth.js `triggerAutoRelogin`), tagged with
// `code: 'GYM_SESSION_EXPIRED'` and the gym it belongs to. An invalid or
// expired the app JWT is a 403 from auth.js `authenticateToken` — a
// different path entirely, never this one.
//
// Pulled out of `api.js`'s fetch wrapper as a pure function (no fetch, no
// DOM) so the routing decision — gym-scoped reconnect vs. whole-app logout —
// can be asserted directly instead of inferred from a mocked response.
export function classifyAuthFailure(status, body, targetGym) {
  if (status === 401 && body && body.code === 'GYM_SESSION_EXPIRED') {
    return { kind: 'gym', gymId: body.gymId || targetGym || null };
  }
  return { kind: 'sa' };
}
