import { afterEach, beforeAll, expect, it, vi } from 'vitest';
let api, openManageSpotMapsModal;
beforeAll(async () => {
  window.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });
  if (!globalThis.localStorage?.getItem) {
    const values = new Map();
    vi.stubGlobal('localStorage', { getItem: k => values.get(k) || null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) });
  }
  ({ api } = await import('../api.js'));
  ({ openManageSpotMapsModal } = await import('./settings.js'));
});
afterEach(() => {
  document.querySelector('#manage-modal-close')?.click();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('shows the five-second message only while gyms remain pending, then clears it', async () => {
  vi.useFakeTimers();
  let complete;
  vi.spyOn(api,'getMyGyms').mockResolvedValue({ gyms: [{ gym_id: 'slow', gym_name: 'Slow Gym' },{gym_id:'ready',gym_name:'Ready Gym'}] });
  vi.spyOn(api,'getStudioPreferences').mockResolvedValue({});
  vi.spyOn(api,'getMetadata').mockImplementation(({gymId}) => gymId === 'slow' ? new Promise(resolve => {complete=resolve;}) : Promise.resolve({studios:[],locations:[]}));
  await openManageSpotMapsModal();
  await vi.advanceTimersByTimeAsync(4999);
  const note = document.querySelector('.set-studios-wait');
  expect(note.hidden).toBe(true);
  expect(document.querySelector('[data-gym-id="ready"]').textContent).not.toContain('Loading studios');
  await vi.advanceTimersByTimeAsync(1);
  expect(note.hidden).toBe(false);
  expect(note.textContent).toBe('Still waiting for some gyms to load.');
  complete({studios:[],locations:[]});
  await vi.advanceTimersByTimeAsync(0);
  expect(note.hidden).toBe(true);
  expect(note.textContent).toBe('');
});
it('does not update a closed manager when a slow gym completes', async () => {
  vi.useFakeTimers();
  let complete;
  vi.spyOn(api,'getMyGyms').mockResolvedValue({gyms:[{gym_id:'slow',gym_name:'Slow Gym'}]});
  vi.spyOn(api,'getStudioPreferences').mockResolvedValue({});
  vi.spyOn(api,'getMetadata').mockImplementation(() => new Promise(resolve => {complete=resolve;}));
  await openManageSpotMapsModal();
  await vi.advanceTimersByTimeAsync(0);
  const overlay=document.querySelector('#app-manage-spotmaps-overlay');
  document.querySelector('#manage-modal-close').click();
  complete({studios:[],locations:[]});
  await vi.advanceTimersByTimeAsync(6000);
  expect(overlay.isConnected).toBe(false);
  expect(overlay.textContent).not.toContain('Still waiting');
});
it('retries only the gym that failed without reloading ready gyms', async () => {
  vi.useFakeTimers();
  vi.spyOn(api,'getMyGyms').mockResolvedValue({gyms:[{gym_id:'failed',gym_name:'Failed Gym'},{gym_id:'ready',gym_name:'Ready Gym'}]});
  vi.spyOn(api,'getStudioPreferences').mockResolvedValue({});
  const metadata=vi.spyOn(api,'getMetadata').mockImplementation(({gymId}) => gymId==='failed' ? Promise.reject(new Error('Network unavailable')) : Promise.resolve({studios:[],locations:[]}));
  await openManageSpotMapsModal();
  await vi.advanceTimersByTimeAsync(0);
  expect(metadata).toHaveBeenCalledTimes(2);
  metadata.mockResolvedValue({studios:[],locations:[]});
  document.querySelector('[data-gym-id="failed"] button').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(metadata).toHaveBeenCalledTimes(3);
  expect(metadata.mock.calls[2][0].gymId).toBe('failed');
  expect(document.querySelector('[data-gym-id="failed"]').textContent).not.toContain('Network unavailable');
});
