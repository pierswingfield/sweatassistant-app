import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

window.matchMedia = window.matchMedia || (() => ({
  matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
}));

let api;
beforeAll(async () => { ({ api } = await import('./api.js')); });

describe('Auto-Book updates', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      code: 'ATTENDEE_LIMIT_EXCEEDED',
      message: 'This gym allows at most 1 self spot per class.',
    }), { status: 400, headers: { 'content-type': 'application/json' } })));
  });

  it('keeps a rejected count update actionable to its editing caller', async () => {
    await expect(api.updateAutoBooking(42, { requiredCount: 2 }))
      .rejects.toMatchObject({
        status: 400,
        code: 'ATTENDEE_LIMIT_EXCEEDED',
        message: 'This gym allows at most 1 self spot per class.',
      });
  });

  it('sends a studio-map draft with the edit instead of saving it separately', async () => {
    const draft = { gymId: 'psycle-london', studioId: '108', preferences: { preferredSlots: [1], preferredRows: [] } };
    await expect(api.updateAutoBooking(42, { requiredCount: 1 }, draft)).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenLastCalledWith('/api/auto-book/42', expect.objectContaining({
      body: JSON.stringify({ preferences: { requiredCount: 1 }, studioPreferenceDraft: draft }),
    }));
  });
});
