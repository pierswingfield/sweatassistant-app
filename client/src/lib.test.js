// Client-side booking-window tests (WP-D10).
//
// Why this file exists: every client change in the multi-gym work so far has been
// verified only by `vite build` succeeding, which catches syntax errors and
// nothing else. That is how a real bug got in and stayed in — `getClassReleaseTime(q || startAt)`
// referencing a `q` that wasn't in scope, a ReferenceError on every countdown
// tick, through a passing build.
//
// The rules under test are the ones where being wrong is INVISIBLE: the app
// renders, the countdown ticks, and it counts to the wrong instant. Those are
// exactly the bugs a build can't catch and a human won't notice until a Monday.

import { describe, it, expect } from 'vitest';
import { DateTime } from 'luxon';
import {
  getClassReleaseTime,
  getBookingOffset,
  detectBookingWindow,
  clampOffsetDays,
  formatCountdown,
} from './lib.js';
import { setLinkedGyms } from './gym-context.js';

const LDN = 'Europe/London';

describe('getClassReleaseTime — which world a class lives in', () => {
  it('uses a server-stamped releaseAt verbatim, whatever weekday it lands on', () => {
    // A rolling-continuous gym (JAB) opens each class a fixed span before it, so
    // releases fall on every weekday. Recomputing a Monday here would be the
    // exact cross-gym bug this whole phase removes.
    const ev = { start_at: '2026-09-15T13:30:00+01:00', releaseAt: '2026-09-01T13:30:00+01:00' };
    const at = getClassReleaseTime(ev);
    expect(at.toUTC().toISO()).toBe('2026-09-01T12:30:00.000Z');
    expect(at.setZone(LDN).weekday).toBe(2); // Tuesday, not Monday
  });

  it('accepts the snake_case release on an auto-book queue row', () => {
    // Normalized events carry `releaseAt`; DB rows carry `release_at`. Both reach
    // this function, and silently ignoring one would fall through to Psycle's
    // weekly model for a gym that has none.
    const row = { start_at: '2026-09-15T13:30:00+01:00', release_at: '2026-09-01T13:30:00+01:00' };
    expect(getClassReleaseTime(row).toUTC().toISO()).toBe('2026-09-01T12:30:00.000Z');
  });

  it('two classes on the same day can open at different times', () => {
    const a = getClassReleaseTime({ releaseAt: '2026-09-01T13:30:00+01:00' });
    const b = getClassReleaseTime({ releaseAt: '2026-09-01T14:00:00+01:00' });
    expect(b.toMillis() - a.toMillis()).toBe(30 * 60 * 1000);
  });

  it('falls back to the weekly model only for a gym positively known as rolling-weekly', () => {
    setLinkedGyms([{ gym_id: 'any-weekly-gym', capabilities: { bookingWindow: 'rolling-weekly' } }]);
    const at = getClassReleaseTime({ start_at: '2026-09-15T19:30:00', gymId: 'any-weekly-gym' }, { detectedBookingOffset: 15 });
    expect(at.setZone(LDN).weekday).toBe(1); // Monday
    expect(at.setZone(LDN).hour).toBe(12);
    const row = getClassReleaseTime({ start_at: '2026-09-15T19:30:00', gym_id: 'any-weekly-gym' }, { detectedBookingOffset: 15 });
    expect(row).not.toBeNull();
  });

  it('resolves NO release (null) for unknown, per-class or continuous gyms, never a Psycle instant', () => {
    setLinkedGyms([
      { gym_id: 'pc', capabilities: { bookingWindow: 'per-class' } },
      { gym_id: 'nocap' },
    ]);
    const start = { start_at: '2026-09-15T19:30:00' };
    expect(getClassReleaseTime(start, { detectedBookingOffset: 15 })).toBeNull(); // no gym
    expect(getClassReleaseTime({ ...start, gymId: 'pc' })).toBeNull();
    expect(getClassReleaseTime({ ...start, gymId: 'nocap' })).toBeNull();
    expect(getClassReleaseTime({ ...start, gymId: 'unlinked' })).toBeNull();
    expect(getClassReleaseTime('2026-09-15T19:30:00')).toBeNull();
    setLinkedGyms([]);
  });

  it('never throws on a missing or malformed input', () => {
    // Called on every countdown tick, so a throw here freezes the whole UI.
    expect(() => getClassReleaseTime(null)).not.toThrow();
    expect(() => getClassReleaseTime({})).not.toThrow();
    expect(() => getClassReleaseTime({ releaseAt: 'not-a-date', start_at: '2026-09-15T19:30:00' })).not.toThrow();
  });
});

describe('getBookingOffset — the window ends on a Tuesday', () => {
  it('defaults to 15 days, so releaseMonday + offset is a Tuesday', () => {
    // Booking for any given Tuesday opens on the Monday. A 14 here would hold
    // Tuesday classes back a whole extra week for standard-tier members.
    expect(getBookingOffset({})).toBe(15);
    const monday = DateTime.fromISO('2026-09-14T12:00:00', { zone: LDN });
    expect(monday.weekday).toBe(1);
    expect(monday.plus({ days: getBookingOffset({}) }).weekday).toBe(2);
  });

  it('uses a detected offset verbatim — no whole-week snapping', () => {
    // Membership tiers extend by DAYS. Snapping 16/17 to 15 truncated two tiers
    // and over-ran the standard one, in both directions.
    for (const days of [15, 16, 17, 18, 22, 23]) {
      expect(getBookingOffset({ detectedBookingOffset: days })).toBe(days);
    }
  });

  it('clamps an absurd stored offset rather than trusting it', () => {
    expect(getBookingOffset({ detectedBookingOffset: 9999 })).toBe(35);
    expect(clampOffsetDays(-5)).toBe(1);
  });

  it('lets a debug day-override win over detection', () => {
    expect(getBookingOffset({ debugMode: true, manualBookingWindowDays: 17, detectedBookingOffset: 22 })).toBe(17);
  });

  it('ignores a debug override when debug mode is off', () => {
    expect(getBookingOffset({ manualBookingWindowDays: 17, detectedBookingOffset: 22 })).toBe(22);
  });
});

describe('detectBookingWindow — reads the cutoff, adjusts nothing', () => {
  const release = DateTime.now().setZone(LDN).set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  const recentRelease = release > DateTime.now().setZone(LDN) ? release.minus({ weeks: 1 }) : release;

  it('passes a day-granular tier through unsnapped', () => {
    const w = detectBookingWindow({ booking_cutoff: recentRelease.plus({ days: 17 }).toISO() }, []);
    expect(w.offsetDays).toBe(17);
    expect(w.source).toBe('standard');
  });

  it('prefers the extended cutoff when extended booking is allowed', () => {
    const w = detectBookingWindow({
      booking_cutoff: recentRelease.plus({ days: 15 }).toISO(),
      extended_cutoff: recentRelease.plus({ days: 23 }).toISO(),
      metafields: { extended_booking_allowed: true },
    }, []);
    expect(w.offsetDays).toBe(23);
    expect(w.extendedAllowed).toBe(true);
  });

  it('ignores credits entirely — that logic is gone from the core', () => {
    // Psycle no longer issues Advanced Booking credits, and while it did, the
    // "15-day floor" was Psycle's promotion wearing a platform-neutral shape.
    const cutoff = recentRelease.plus({ days: 15 }).toISO();
    const withCredits = detectBookingWindow({ booking_cutoff: cutoff }, [{ credit_type_id: 8, count: 3 }]);
    const without = detectBookingWindow({ booking_cutoff: cutoff }, []);
    expect(withCredits).toEqual(without);
    expect(withCredits.source).not.toBe('credits');
  });

  it('returns null rather than guessing when the profile has no cutoff', () => {
    expect(detectBookingWindow(null, [])).toBeNull();
    expect(detectBookingWindow({}, [])).toBeNull();
    expect(detectBookingWindow({ booking_cutoff: 'nonsense' }, [])).toBeNull();
  });
});

describe('formatCountdown', () => {
  it('renders hours:minutes:seconds, and days past 24h', () => {
    expect(formatCountdown(0)).toBe('00:00:00');
    expect(formatCountdown(-1)).toBe('00:00:00');
    expect(formatCountdown(65 * 1000)).toBe('00:01:05');
    expect(formatCountdown(26 * 3600 * 1000)).toBe('1d 2h');
  });
});
