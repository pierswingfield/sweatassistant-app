// C1-2: one gym's dead session must not log the whole app out. `apiFetch`'s
// 401 handler used to treat EVERY 401 as the the app session expiring
// — but the only 401 the server ever sends on an authenticated request is
// routes-normalized.js `resolveContext` (or auth.js `triggerAutoRelogin`)
// reporting that ONE linked gym's session is dead; an invalid/expired SA JWT
// is a 403 (see auth.js authenticateToken), a different path entirely.
//
// classifyAuthFailure() is the routing decision pulled out of the fetch
// wrapper so it can be asserted directly, without mocking `fetch`/DOM.

import { describe, it, expect } from 'vitest';
import { classifyAuthFailure } from './auth-failure.js';

describe('classifyAuthFailure', () => {
  it('routes a gym-tagged 401 to that gym, not to SA logout', () => {
    const decision = classifyAuthFailure(401, { message: 'No active session for this gym. Please log in.', code: 'GYM_SESSION_EXPIRED', gymId: 'jab-boxing' }, null);
    expect(decision).toEqual({ kind: 'gym', gymId: 'jab-boxing' });
  });

  it('falls back to the request-scoped gymId if the body omits one', () => {
    const decision = classifyAuthFailure(401, { code: 'GYM_SESSION_EXPIRED' }, 'psycle-london');
    expect(decision).toEqual({ kind: 'gym', gymId: 'psycle-london' });
  });

  it('treats a 401 with no GYM_SESSION_EXPIRED code as SA session expiry', () => {
    const decision = classifyAuthFailure(401, { message: 'Authorization token required' }, null);
    expect(decision.kind).toBe('sa');
  });

  it('treats a 401 with an unparseable/empty body as SA session expiry', () => {
    expect(classifyAuthFailure(401, null, null).kind).toBe('sa');
  });

  it('does not mistake a differently-coded error for a gym session expiry', () => {
    const decision = classifyAuthFailure(401, { code: 'NO_GYM_LINKED' }, 'psycle-london');
    expect(decision.kind).toBe('sa');
  });
});
