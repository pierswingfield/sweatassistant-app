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
//
// C3-6: every call below now passes an explicit gymId (or a test event
// carrying `gymId`), matching how every real production call site already
// worked — `setGymContext()`/an ambient "ACTIVE gym" never had a production
// caller in this file's functions to begin with. `setLinkedGyms([gym])` seeds
// the same per-gym capability lookup `canForGym`/`capabilityForGym` use.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// credit-allowance.js imports `cache` from main.js, which pulls in the whole
// app shell. Stub it — the arithmetic under test only reads `cache.profile`
// and (for WP-J) `cache.eligibility`.
const cache = { profile: null, eligibility: null };
vi.mock('../main', () => ({ cache }));

const { getAvailableCreditsForEvent, hasUsableCredit, getTotalCredits, isMetered, canBookAtAll, getIneligibleReason } =
  await import('./credit-allowance.js');
const { setLinkedGyms } = await import('../gym-context.js');

const METERED_ID = 'psycle-london';
const MEMBERSHIP_ID = 'jab-boxing';
const METERED = {
  gym_id: METERED_ID, id: METERED_ID, name: 'Psycle London',
  capabilities: { metered: true, creditPurchase: true },
};
const MEMBERSHIP = {
  gym_id: MEMBERSHIP_ID, id: MEMBERSHIP_ID, name: 'JAB Boxing Club',
  capabilities: { metered: false, creditPurchase: false },
};

beforeEach(() => { cache.profile = null; cache.eligibility = null; });

describe('a membership (unmetered) gym', () => {
  beforeEach(() => setLinkedGyms([MEMBERSHIP]));

  it('reports Infinity, not 0, for the total balance', () => {
    // 0 is the dangerous answer: every `total < needed` check downstream turns
    // it into a blocking warning.
    expect(getTotalCredits(MEMBERSHIP_ID)).toBe(Infinity);
  });

  it('still reports Infinity when a profile exists with an empty balance', () => {
    // The real JAB shape — a profile loads, `available_credits` is just empty.
    cache.profile = { available_credits: [] };
    expect(getTotalCredits(MEMBERSHIP_ID)).toBe(Infinity);
    expect(getAvailableCreditsForEvent({ gymId: MEMBERSHIP_ID, credits: { required: 1, acceptedTypeIds: ['8'] } })).toBe(Infinity);
    expect(hasUsableCredit({ gymId: MEMBERSHIP_ID, credits: { required: 1, acceptedTypeIds: ['8'] } })).toBe(true);
  });

  it('never looks short of credits for any spot count', () => {
    // The exact comparisons the four call sites make.
    for (const needed of [1, 2, 5]) {
      expect(getTotalCredits(MEMBERSHIP_ID) < needed).toBe(false);
    }
  });

  it('knows it is unmetered', () => {
    expect(isMetered(MEMBERSHIP_ID)).toBe(false);
  });
});

describe('a metered gym', () => {
  beforeEach(() => setLinkedGyms([METERED]));

  it('sums the balance', () => {
    cache.profile = { available_credits: [{ count: 2 }, { count: 3 }] };
    expect(getTotalCredits(METERED_ID)).toBe(5);
  });

  it('reports 0 when there is genuinely no balance — this gym CAN be short', () => {
    cache.profile = { available_credits: [] };
    expect(getTotalCredits(METERED_ID)).toBe(0);
    expect(getTotalCredits(METERED_ID) < 1).toBe(true);
  });

  it('does NOT report 0 before anything has loaded — loading is not "broke"', () => {
    // Inverted deliberately on 2026-09-15. "Nothing loaded" used to answer 0,
    // which every `total < needed` check downstream turned into a blocking
    // warning — so on first paint EVERY row said "Buy Credits", including a
    // membership gym's, and only corrected once the user switched days and
    // forced a re-render.
    //
    // Same rule as an unknown capability flag: briefly offering a class you
    // cannot afford self-corrects at the booking attempt; wrongly disabling
    // every Book button does not.
    expect(getTotalCredits(METERED_ID)).toBe(Infinity);
  });

  it('reports 0 once a balance has genuinely loaded and is empty', () => {
    cache.profile = { available_credits: [] };
    expect(getTotalCredits(METERED_ID)).toBe(0);
  });

  it('counts only credit types the class accepts', () => {
    // Real Psycle data: accepted type lists differ per class — a "Ride Only"
    // credit is accepted by ride classes and refused elsewhere.
    cache.profile = { available_credits: [
      { typeId: '8', count: 4 },
      { typeId: '9', count: 7 },
    ] };
    expect(getAvailableCreditsForEvent({ gymId: METERED_ID, credits: { required: 1, acceptedTypeIds: ['8'] } })).toBe(4);
  });

  it('divides by the class cost — a 2-credit class is not affordable on 1', () => {
    // Confirmed live 2026-09-14: of 705 Psycle events, 4 required 2 credits.
    // The old code assumed 1 and reported such a class bookable on a balance
    // of 1, which fails at the booking attempt instead of in the UI.
    cache.profile = { available_credits: [{ typeId: '8', count: 1 }] };
    const twoCredit = { gymId: METERED_ID, credits: { required: 2, acceptedTypeIds: ['8'] } };
    expect(getAvailableCreditsForEvent(twoCredit)).toBe(0);
    expect(hasUsableCredit(twoCredit)).toBe(false);

    cache.profile = { available_credits: [{ typeId: '8', count: 3 }] };
    // 3 credits at 2 each = one bookable spot, not three.
    expect(getAvailableCreditsForEvent(twoCredit)).toBe(1);
  });

  it('treats a genuinely free class (required 0) as always bookable', () => {
    cache.profile = { available_credits: [] };
    expect(getAvailableCreditsForEvent({ gymId: METERED_ID, credits: { required: 0, acceptedTypeIds: [] } })).toBe(Infinity);
  });

  it('ignores guest-only credits — they book a guest in, not you', () => {
    // 11 of Psycle's 46 credit types are guest-only, and classes DO accept
    // them, so counting them said "you can book" to someone who cannot.
    cache.profile = { available_credits: [
      { typeId: '2', count: 5, isGuestOnly: true },
      { typeId: '8', count: 1 },
    ] };
    expect(getAvailableCreditsForEvent({ gymId: METERED_ID, credits: { required: 1, acceptedTypeIds: ['2', '8'] } })).toBe(1);
  });

  it('does NOT treat a missing credits field as free', () => {
    // Absent means "the payload said nothing", not "free". Returning Infinity
    // here would let a normalization gap silently unlock every class — which is
    // exactly what happened before NormalizedEvent carried these fields.
    cache.profile = { available_credits: [] };
    expect(getAvailableCreditsForEvent({ gymId: METERED_ID })).toBe(0);
  });
});

// WP-J: "can this account book at all" is a THIRD question, distinct from
// metered/creditPurchase. A membership gym's credit total is Infinity by
// design (nothing to charge), so it says nothing about whether the account
// actually has a membership — this is the gap that let a JAB user with no
// membership see no warning and just fail at the booking attempt.
describe('account-level eligibility (WP-J)', () => {
  describe('a membership (unmetered) gym', () => {
    beforeEach(() => setLinkedGyms([MEMBERSHIP]));

    it('reports canBook: true with an active membership', () => {
      cache.eligibility = { canBook: true };
      expect(canBookAtAll(MEMBERSHIP_ID)).toBe(true);
      expect(getIneligibleReason(MEMBERSHIP_ID)).toBeNull();
      // Infinity credits AND eligible — the class is actually bookable.
      expect(hasUsableCredit({ gymId: MEMBERSHIP_ID, credit_types: [] })).toBe(true);
    });

    it('reports canBook: false with no membership, distinct from the credit answer', () => {
      cache.eligibility = { canBook: false, reason: 'No active membership or credits' };
      expect(canBookAtAll(MEMBERSHIP_ID)).toBe(false);
      expect(getIneligibleReason(MEMBERSHIP_ID)).toBe('No active membership or credits');
      // Credit arithmetic alone still (correctly) says Infinity — this is
      // exactly why membership status can't be derived from it.
      expect(getTotalCredits(MEMBERSHIP_ID)).toBe(Infinity);
      // But the combined "can I actually book this" answer must be false.
      expect(hasUsableCredit({ gymId: MEMBERSHIP_ID, credit_types: [] })).toBe(false);
    });

    it('defaults permissive while eligibility has not loaded yet', () => {
      // cache.eligibility is null (beforeEach) — must not block booking on a
      // slow/failed fetch, same "unknown defaults ON" rule as capabilities.
      expect(canBookAtAll(MEMBERSHIP_ID)).toBe(true);
      expect(getIneligibleReason(MEMBERSHIP_ID)).toBeNull();
    });
  });

  describe('a metered gym', () => {
    beforeEach(() => setLinkedGyms([METERED]));

    it('is unaffected by eligibility when it has real credit', () => {
      cache.profile = { available_credits: [{ count: 3 }] };
      cache.eligibility = { canBook: true };
      expect(hasUsableCredit({ gymId: METERED_ID, credit_types: [] })).toBe(true);
    });

    it('still reports insufficient via credit math, not eligibility, when out of credit', () => {
      cache.profile = { available_credits: [] };
      cache.eligibility = { canBook: true };
      // A class that DOES draw against a credit type, with none held.
      expect(hasUsableCredit({ gymId: METERED_ID, credit_types: [{ credit_type: 8 }] })).toBe(false);
      expect(getIneligibleReason(METERED_ID)).toBeNull(); // the reason here is credit, not eligibility
    });
  });
});
