import { describe, it, expect } from 'vitest';
import { decideRefresh, TIMETABLE_TTL_MS, CONTEXT_TTL_MS } from './refresh-policy.js';

describe('decideRefresh', () => {
  it('cold start or force: full, visible load', () => {
    expect(decideRefresh({ hasCached: false })).toMatchObject({ timetable: true, context: true, silent: false, skip: false });
    expect(decideRefresh({ force: true, hasCached: true, timetableAgeMs: 1, contextAgeMs: 1 })).toMatchObject({ silent: false, skip: false });
  });
  it('fresh cache and fresh bookings: skip entirely', () => {
    expect(decideRefresh({ hasCached: true, timetableAgeMs: 1000, contextAgeMs: 1000 }).skip).toBe(true);
  });
  it('fresh timetable, stale bookings: context only, silent', () => {
    expect(decideRefresh({ hasCached: true, timetableAgeMs: 1000, contextAgeMs: CONTEXT_TTL_MS + 1 }))
      .toEqual({ timetable: false, context: true, silent: true, skip: false });
  });
  it('stale timetable: refetch silently', () => {
    expect(decideRefresh({ hasCached: true, timetableAgeMs: TIMETABLE_TTL_MS + 1, contextAgeMs: 0 }))
      .toMatchObject({ timetable: true, silent: true, skip: false });
  });
  it('unknown ages are stale', () => {
    expect(decideRefresh({ hasCached: true })).toMatchObject({ timetable: true, context: true });
  });
});
