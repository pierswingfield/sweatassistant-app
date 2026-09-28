import { describe, it, expect } from 'vitest';
import { bookingNotifyPayload } from './booking-notify.js';

describe('bookingNotifyPayload (U1-16)', () => {
  it('reads normalized fields for a Psycle event whose raw has none of them', () => {
    const event = {
      id: '4411', gymId: 'psycle-london', name: 'Signature 45', discipline: 'RIDE',
      startAt: '2026-10-01T06:30:00', instructors: [{ id: '9', name: 'Aanya Smith' }],
      raw: { id: 4411, event_type: { name: 'Signature 45' }, instructor: { full_name: 'Aanya Smith' }, start_datetime: '2026-10-01 06:30:00' },
    };
    const p = bookingNotifyPayload(event, { source: 'quickbook', slots: ['5'] });
    expect(p).toEqual({
      source: 'quickbook', eventId: '4411', gymId: 'psycle-london', className: 'Signature 45',
      groupName: 'RIDE', instructorName: 'Aanya Smith', startAt: '2026-10-01T06:30:00', slots: ['5'],
    });
  });

  it('handles a JAB event and an explicit gym override', () => {
    const p = bookingNotifyPayload({ id: '7', gymId: 'jab-boxing', name: 'TRAIN - Upper (Focus)', discipline: 'TRAIN', startAt: '2026-10-01T18:00:00', instructors: [{ name: 'Coach K' }] }, { gymId: 'jab-boxing' });
    expect(p.groupName).toBe('TRAIN');
    expect(p.instructorName).toBe('Coach K');
    expect(p.gymId).toBe('jab-boxing');
  });

  it('never throws and never emits undefined for an event with no instructor', () => {
    const p = bookingNotifyPayload({ id: '1', name: 'X', startAt: 'z' });
    expect(p.instructorName).toBe('');
    expect(p.groupName).toBe('');
    expect(bookingNotifyPayload(null).className).toBe('');
  });
});
