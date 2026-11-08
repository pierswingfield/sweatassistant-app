import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSpotMapGyms } from './spot-map-loading.js';

afterEach(() => vi.useRealTimers());
const gyms = [{ gym_id: 'slow' }, { gym_id: 'ready' }];
const metadata = { studios: [{ id: 'same-id', hasLayout: true }], locations: [] };
describe('preferred-map gym loading', () => {
  it('renders a ready gym while another gym remains pending, with explicit gym credentials', async () => {
    let resolveSlow;
    const slow = new Promise(resolve => { resolveSlow = resolve; });
    const api = {
      getMetadata: vi.fn(({ gymId }) => gymId === 'slow' ? slow : Promise.resolve(metadata)),
      getStudioPreferences: vi.fn(gymId => Promise.resolve({ owner: gymId })),
    };
    const onResult = vi.fn();
    const pending = loadSpotMapGyms(gyms, api, { onResult });
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult.mock.calls[0][0]).toMatchObject({ gymId: 'ready', preferences: { owner: 'ready' } });
    expect(api.getMetadata).toHaveBeenCalledWith({ gymId: 'slow', ttlMs: 3600000 });
    expect(api.getStudioPreferences).toHaveBeenCalledWith('ready');
    resolveSlow(metadata);
    await pending;
    expect(onResult).toHaveBeenCalledTimes(2);
  });
  it('reports a timed-out gym separately and never emits its late result', async () => {
    vi.useFakeTimers();
    let resolveSlow;
    const slow = new Promise(resolve => { resolveSlow = resolve; });
    const api = { getMetadata: ({ gymId }) => gymId === 'slow' ? slow : Promise.resolve(metadata), getStudioPreferences: async () => ({}) };
    const onResult = vi.fn();
    const pending = loadSpotMapGyms(gyms, api, { onResult, timeoutMs: 6000 });
    await vi.advanceTimersByTimeAsync(6000);
    const results = await pending;
    expect(results.find(r => r.gymId === 'slow').error.message).toMatch(/timed out/);
    expect(results.find(r => r.gymId === 'ready').metadata).toEqual(metadata);
    resolveSlow(metadata);
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
