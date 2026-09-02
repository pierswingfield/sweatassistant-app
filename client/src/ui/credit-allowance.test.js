// Credit arithmetic must answer "nothing to charge" — not "you have none".
//
// `metered` and `creditPurchase` are different questions: metered is "a class
// draws down a credit balance", creditPurchase is "we can sell top-ups in-app".
// JAB is neither. On an unmetered gym there is no balance to be short of, so
// every credit answer is Infinity and no warning may render.
//
// Why this file exists: WP-D12 consolidated the per-event arithmetic into
// credit-allowance.js, but the TOTAL-balance variant stayed inline in four
// modules (autobook, autoupgrade, and twice in bookings). Each summed an absent
// `available_credits` to 0, compared `0 < 1`, and rendered "⚠ Insufficient
// Credits" on every JAB card — which reads as "you cannot book" at a membership
// gym. Nothing threw, no test covered it, and it was found only by looking at
// the running app. Consolidation is not done until the last copy is gone.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// credit-allowance.js imports `cache` from main.js, which pulls in the whole
// app shell. Stub it — the arithmetic under test only reads `cache.profile`.
const cache = { profile: null };
vi.mock('../main', () => ({ cache }));

const { getAvailableCreditsForEvent, hasUsableCredit, getTotalCredits, isMetered } =
  await import('./credit-allowance.js');
const { setGymContext } = await import('../gym-context.js');

const METERED = {
  id: 'psycle-london', name: 'Psycle London',
  capabilities: { metered: true, creditPurchase: true },
};
const MEMBERSHIP = {
  id: 'jab-boxing', name: 'JAB Boxing Club',
  capabilities: { metered: false, creditPurchase: false },
};

beforeEach(() => { cache.profile = null; });

describe('a membership (unmetered) gym', () => {
  beforeEach(() => setGymContext(MEMBERSHIP));

  it('reports Infinity, not 0, for the total balance', () => {
    // 0 is the dangerous answer: every `total < needed` check downstream turns
    // it into a blocking warning.
    expect(getTotalCredits()).toBe(Infinity);
  });

  it('still reports Infinity when a profile exists with an empty balance', () => {
    // The real JAB shape — a profile loads, `available_credits` is just empty.
    cache.profile = { available_credits: [] };
    expect(getTotalCredits()).toBe(Infinity);
    expect(getAvailableCreditsForEvent({ credit_types: [{ credit_type: 8 }] })).toBe(Infinity);
    expect(hasUsableCredit({ credit_types: [{ credit_type: 8 }] })).toBe(true);
  });

  it('never looks short of credits for any spot count', () => {
    // The exact comparisons the four call sites make.
    for (const needed of [1, 2, 5]) {
      expect(getTotalCredits() < needed).toBe(false);
    }
  });

  it('knows it is unmetered', () => {
    expect(isMetered()).toBe(false);
  });
});

describe('a metered gym', () => {
  beforeEach(() => setGymContext(METERED));

  it('sums the balance', () => {
    cache.profile = { available_credits: [{ count: 2 }, { count: 3 }] };
    expect(getTotalCredits()).toBe(5);
  });

  it('reports 0 when there is genuinely no balance — this gym CAN be short', () => {
    cache.profile = { available_credits: [] };
    expect(getTotalCredits()).toBe(0);
    expect(getTotalCredits() < 1).toBe(true);
  });

  it('reports 0 before the profile has loaded', () => {
    expect(getTotalCredits()).toBe(0);
  });

  it('counts only credit types the class accepts', () => {
    cache.profile = { available_credits: [
      { credit_type: { id: 8 }, count: 4 },
      { credit_type: { id: 9 }, count: 7 },
    ] };
    expect(getAvailableCreditsForEvent({ credit_types: [{ credit_type: 8 }] })).toBe(4);
  });

  it('treats a class with no credit type as free to book', () => {
    cache.profile = { available_credits: [] };
    expect(getAvailableCreditsForEvent({ credit_types: [] })).toBe(Infinity);
  });
});
