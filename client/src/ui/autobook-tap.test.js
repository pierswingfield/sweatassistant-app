import { describe, expect, it } from 'vitest';
import { autoBookTapAction, findScheduledEntry } from './autobook-tap.js';
import { autoBookOutcomeToasts, autoBookFailureToast } from './autobook-outcome.js';

describe('one-tap Auto-Book decision', () => {
  it('queues in one tap with a saved map or when the studio has no seat map', () => {
    expect(autoBookTapAction({ hasMap: true, hasPrefs: true })).toBe('queue-now');
    expect(autoBookTapAction({ hasMap: false, hasPrefs: false })).toBe('queue-now');
  });
  it('opens the setup flow when there is a map but no saved preferences', () => {
    expect(autoBookTapAction({ hasMap: true, hasPrefs: false })).toBe('open-setup');
  });
});

describe('Auto-Book outcome toasts', () => {
  it('success alone', () => {
    expect(autoBookOutcomeToasts({ className: 'Ride 45' }).map((t) => t.type)).toEqual(['success']);
  });
  it('adds server warnings, the credit shortfall and the guest note after success', () => {
    const toasts = autoBookOutcomeToasts({
      className: 'Ride 45', warnings: [{ message: 'Overlaps your 07:30 class' }, { message: 'Already booked' }], shortfall: 1, guestWarning: 'Guest rechecked later',
    });
    expect(toasts[0].type).toBe('success');
    expect(toasts.slice(1).map((t) => t.text)).toEqual([
      'Overlaps your 07:30 class', 'Already booked', '1 more credit is required for Auto-Book to work.', 'Guest rechecked later',
    ]);
    expect(toasts.slice(1).every((t) => t.type === 'warning')).toBe(true);
  });
  it('pluralises the credit warning', () => {
    expect(autoBookOutcomeToasts({ className: 'x', shortfall: 3 })[1].text).toBe('3 more credits are required for Auto-Book to work.');
  });
  it('a duplicate refusal is an error toast', () => {
    const t = autoBookFailureToast(Object.assign(new Error('This class is already in your Auto-Book queue.'), { code: 'DUPLICATE_AUTO_BOOK', status: 409 }));
    expect(t.type).toBe('error');
    expect(t.text).toContain('already in your Auto-Book queue');
  });
});

describe('tapping Scheduled opens the entry, never deletes it', () => {
  const list = [{ id: 1, event_id: 100, gym_id: 'a' }, { id: 2, event_id: 100, gym_id: 'b' }, { id: 3, event_id: 200, gym_id: 'a' }];
  it('finds the queued entry for the event and gym (wrapped or bare list)', () => {
    expect(findScheduledEntry(list, { id: '100', gymId: 'b' }).id).toBe(2);
    expect(findScheduledEntry({ data: list }, { id: 200, gymId: 'a' }).id).toBe(3);
  });
  it('returns null when nothing is queued', () => {
    expect(findScheduledEntry(list, { id: 999, gymId: 'a' })).toBeNull();
    expect(findScheduledEntry(undefined, { id: 1 })).toBeNull();
  });
});
