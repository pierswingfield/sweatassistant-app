import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { addAutoBooking: vi.fn(), updateAutoBooking: vi.fn(async () => ({})), deleteAutoBooking: vi.fn(async () => ({})) };
let captured;
vi.mock('../api', () => ({ api }));
vi.mock('../main', () => ({ showToast: vi.fn(), cache: {}, userSettings: {}, refreshUserData: vi.fn(), debugConsole: vi.fn() }));
vi.mock('./timetable', () => ({
  openBookingModal: vi.fn(async (_event, _mode, opts) => { captured = opts; }), renderTimetableGrid: vi.fn(async () => {}),
  pickStudioPrefs: vi.fn(), metadata: { instructors: [] }, loadMetadata: vi.fn(async () => {}),
  rowGroupsForStudio: vi.fn(), mobileRotationForStudio: vi.fn(),
}));

let openAutoBookEditModal;
beforeEach(async () => {
  vi.clearAllMocks();
  window.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} });
  ({ openAutoBookEditModal } = await import('./autobook.js'));
});

describe('existing Auto-Book edit', () => {
  it('routes Save to the update API with the map draft and participants, never create', async () => {
    await openAutoBookEditModal({ id: 7, event_id: 'e1', gym_id: 'g1', studio_id: 's1', preferences: {}, participants: [] });
    expect(captured.autoBookEdit.id).toBe(7);
    const close = vi.fn();
    captured.autoBookEdit.onSubmit({ slots: [3], rows: [], qty: 2, bookAny: true, prioritizeTogether: true, autoUpgrade: false, guests: [{ email: 'a@b.c', name: null }], close });
    await vi.waitFor(() => expect(api.updateAutoBooking).toHaveBeenCalledTimes(1));
    const [id, body, draft] = api.updateAutoBooking.mock.calls[0];
    expect(id).toBe(7);
    expect(body).toMatchObject({ requiredCount: 2, prioritizeTogether: true, guests: [{ email: 'a@b.c', name: null }] });
    expect(draft).toEqual({ gymId: 'g1', studioId: 's1', preferences: { preferredSlots: [3], preferredRows: [] } });
    expect(api.addAutoBooking).not.toHaveBeenCalled();
  });

  it('the edit screen offers Remove, and only that deletes the entry', async () => {
    await openAutoBookEditModal({ id: 9, event_id: 'e2', gym_id: 'g1', studio_id: 's1', preferences: {}, participants: [] });
    expect(api.deleteAutoBooking).not.toHaveBeenCalled();
    const close = vi.fn();
    captured.autoBookEdit.onRemove({ close });
    await vi.waitFor(() => expect(api.deleteAutoBooking).toHaveBeenCalledWith(9));
    expect(close).toHaveBeenCalled();
    expect(api.addAutoBooking).not.toHaveBeenCalled();
  });
});
