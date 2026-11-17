import { describe, it, expect, beforeEach } from 'vitest';
import {
  setGymProblem, clearGymProblem, gymProblem, anyGymProblem, resetGymProblems,
  syncLinkProblems, noteGymResponse, onGymProblemChange,
} from './gym-problem-state.js';

beforeEach(() => resetGymProblems());

describe('header gym dot: loading problems only', () => {
  it('no dot for a healthy gym, zero credits or no membership (those are balances, not problems)', () => {
    syncLinkProblems([{ gym_id: 'a', status: 'active', account_enabled: 1, relogin_suspended: 0 }]);
    noteGymResponse('a', 200);
    expect(anyGymProblem(['a'])).toBe(false);
    expect(() => setGymProblem('a', 'zero-credits')).not.toThrow();
    expect(() => setGymProblem('a', 'no-membership')).not.toThrow();
    expect(anyGymProblem(['a'])).toBe(false);
  });
  it('dot for needs re-login', () => {
    syncLinkProblems([{ gym_id: 'a', status: 'needs_relogin', account_enabled: 1 }]);
    expect(gymProblem('a')).toBe('needs-relogin');
    expect(anyGymProblem(['a'])).toBe(true);
  });
  it('dot for relogin suspended, and it clears when the link recovers', () => {
    syncLinkProblems([{ gym_id: 'a', status: 'active', account_enabled: 1, relogin_suspended: 1 }]);
    expect(gymProblem('a')).toBe('relogin-suspended');
    syncLinkProblems([{ gym_id: 'a', status: 'active', account_enabled: 1, relogin_suspended: 0 }]);
    expect(anyGymProblem(['a'])).toBe(false);
  });
  it('a disabled link raises nothing', () => {
    syncLinkProblems([{ gym_id: 'a', status: 'needs_relogin', account_enabled: 0 }]);
    expect(anyGymProblem(['a'])).toBe(false);
  });
  it('dot for a throttled gym (429) and a failed load (5xx); a later good read clears either', () => {
    noteGymResponse('a', 429);
    expect(gymProblem('a')).toBe('throttled');
    noteGymResponse('a', 503);
    expect(gymProblem('a')).toBe('load-failed');
    noteGymResponse('a', 200);
    expect(anyGymProblem(['a'])).toBe(false);
  });
  it('client errors (400/404/409) are not loading problems', () => {
    [400, 403, 404, 409].forEach((s) => noteGymResponse('a', s));
    expect(anyGymProblem(['a'])).toBe(false);
  });
  it('a good read does not clear a login problem; login problems outrank load problems', () => {
    setGymProblem('a', 'needs-relogin'); setGymProblem('a', 'load-failed');
    noteGymResponse('a', 200);
    expect(gymProblem('a')).toBe('needs-relogin');
  });
  it('problems are per gym and notify subscribers once per change', () => {
    let n = 0; onGymProblemChange(() => { n++; });
    noteGymResponse('a', 500); noteGymResponse('a', 500);
    expect(n).toBe(1);
    expect(anyGymProblem(['b'])).toBe(false);
    clearGymProblem('a'); expect(n).toBe(2);
  });
});
