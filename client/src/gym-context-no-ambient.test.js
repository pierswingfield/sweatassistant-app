// Guard for C3-6 (2026-09-27): the client used to hold an ambient
// module-level `state` in gym-context.js — ONE gym the whole module defaulted
// to via `setGymContext()`/`getGymContext()`/`can()` whenever a caller hadn't
// been threaded with an explicit gym. That was the client twin of the
// server-side "active gym" bug class removed 2026-09-16 (guarded server-side
// by `server/test-no-active-gym.js`, which also source-scans `client/src` for
// an ambient `can(...)` call). This is the client-side half of that guard:
// it fails if the ambient EXPORTS themselves are ever reintroduced, which a
// pure usage-scan can't catch (an unused re-export wouldn't show up as a call
// site, but it would still be the same trap for the next caller).

import { describe, it, expect } from 'vitest';
import * as gymContext from './gym-context.js';

describe('gym-context.js has no ambient "active gym" surface (C3-6 guard)', () => {
  it('does not export the removed ambient API', () => {
    // If any of these come back, someone re-added the guessed-gym fallback —
    // every consumer must pass an explicit gym instead.
    expect(gymContext.setGymContext).toBeUndefined();
    expect(gymContext.getGymContext).toBeUndefined();
    expect(gymContext.can).toBeUndefined();
    expect(gymContext.onGymContextChange).toBeUndefined();
  });

  it('still exports the explicit-gym replacements', () => {
    expect(typeof gymContext.canForGym).toBe('function');
    expect(typeof gymContext.capabilityForGym).toBe('function');
    expect(typeof gymContext.canAny).toBe('function');
    expect(typeof gymContext.setLinkedGyms).toBe('function');
    expect(typeof gymContext.getLinkedGyms).toBe('function');
  });
});
