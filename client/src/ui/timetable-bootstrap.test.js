import { beforeAll, expect, it, vi } from 'vitest';
import { setLinkedGyms } from '../gym-context.js';
import { setCacheKeyPrefix } from '../cache.js';
let api, timetable;
beforeAll(async () => {
  window.matchMedia ||= () => ({ matches: false, addEventListener() {}, addListener() {} });
  ({ api } = await import('../api.js'));
  timetable = await import('./timetable.js');
});
it('does not bootstrap again when a denied empty timetable announces completion; explicit retry still works', async () => {
  document.body.innerHTML = '<div id="app-timetable-grid"></div>';
  setCacheKeyPrefix('bootstrap-user');
  setLinkedGyms([{ gym_id: 'gym-a', capabilities: {} }]);
  const spies = [
    vi.spyOn(api, 'getMetadata').mockResolvedValue({}),
    vi.spyOn(api, 'getBookings').mockResolvedValue([]),
    vi.spyOn(api, 'getWaitlists').mockResolvedValue([]),
    vi.spyOn(api, 'getAutoBookings').mockResolvedValue([]),
    vi.spyOn(api, 'getStudioPreferences').mockResolvedValue({}),
  ];
  const load = vi.spyOn(api, 'getTimetableProgressive').mockRejectedValue(new Error('Provider reads disabled'));
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let completions = 0;
  const repaintHome = () => {
    // This is Home's real feedback edge: its favourites loader ensures an empty
    // timetable on every completion. Bound the pre-fix repro to three turns.
    if (++completions < 3) timetable.ensureScheduleLoaded();
  };
  window.addEventListener('app-timetable-rendered', repaintHome);
  try {
    timetable.ensureScheduleLoaded();
    await new Promise(r => setTimeout(r, 100));
    expect(load).toHaveBeenCalledTimes(1);
    expect(completions).toBe(1);
    await timetable.prefetchTimetableData(true);
    expect(load).toHaveBeenCalledTimes(2);
    setCacheKeyPrefix('another-bootstrap-user');
    timetable.ensureScheduleLoaded();
    await new Promise(r => setTimeout(r, 50));
    expect(load).toHaveBeenCalledTimes(3);
    // A changed linked-gym set gets its own bootstrap. A valid empty result
    // must settle too, rather than retrying just because it contains no rows.
    setLinkedGyms([{ gym_id: 'gym-b', capabilities: {} }]);
    load.mockResolvedValue([]);
    const errorCount = errors.mock.calls.length;
    timetable.ensureScheduleLoaded();
    await new Promise(r => setTimeout(r, 50));
    expect(load).toHaveBeenCalledTimes(4);
    expect(errors).toHaveBeenCalledTimes(errorCount);
    timetable.ensureScheduleLoaded();
    await new Promise(r => setTimeout(r, 50));
    expect(load).toHaveBeenCalledTimes(4);
    // A new date changes the prefetch window in a tab left open overnight.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2090-06-15T12:00:00Z'));
    timetable.ensureScheduleLoaded();
    await new Promise(r => setTimeout(r, 50));
    expect(load).toHaveBeenCalledTimes(5);
  } finally {
    vi.useRealTimers();
    window.removeEventListener('app-timetable-rendered', repaintHome);
    [...spies, load, errors].forEach(s => s.mockRestore());
    document.body.innerHTML = '';
  }
});
