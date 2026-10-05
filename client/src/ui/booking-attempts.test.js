import { describe, expect, it, vi } from 'vitest';
import { bookCandidateSpots, isRetryableSpotFailure } from './booking-attempts.js';

describe('Quick-Book candidate retries', () => {
  it('retries only when the provider says the candidate spot is unavailable', async () => {
    const book = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'SPOT_UNAVAILABLE', error: 'Spot is no longer available.' })
      .mockResolvedValueOnce({ ok: true, bookingId: 'b2' });
    const result = await bookCandidateSpots({ candidates: ['A', 'B'], book, retryDelayMs: 0 });
    expect(book.mock.calls.map(([slot]) => slot)).toEqual(['A', 'B']);
    expect(result.booked).toHaveLength(1);
    expect(result.booked[0].slotId).toBe('B');
    expect(result.terminalError).toBeNull();
  });

  it.each([
    [{ code: 'ALREADY_BOOKED', status: 409, error: 'You already have a reservation.' }],
    [{ code: 'BOOKING_TIMEOUT', error: 'Booking timed out.' }],
    [{ status: 400, error: 'The payments do not satisfy the cost.' }],
  ])('stops after a terminal booking result', async (failure) => {
    const book = vi.fn().mockResolvedValue({ ok: false, ...failure });
    const result = await bookCandidateSpots({ candidates: ['A', 'B', 'C'], book, retryDelayMs: 0 });
    expect(book).toHaveBeenCalledTimes(1);
    expect(result.booked).toEqual([]);
    expect(result.terminalError).toMatchObject(failure);
  });

  it('does not classify a duplicate booking conflict as a spot race', () => {
    expect(isRetryableSpotFailure({ status: 409, error: 'Already booked for this class.' })).toBe(false);
    expect(isRetryableSpotFailure({ status: 409, error: 'Spot is no longer available.' })).toBe(true);
  });

  it('ends candidate retries at the shared booking deadline', async () => {
    const book = vi.fn().mockResolvedValue({ ok: false, code: 'SPOT_UNAVAILABLE', error: 'Spot was taken.' });
    const result = await bookCandidateSpots({ candidates: ['A', 'B'], book, retryDelayMs: 20, timeoutMs: 10 });
    expect(book).toHaveBeenCalledTimes(1);
    expect(result.terminalError.code).toBe('BOOKING_TIMEOUT');
  });
});
