// Client unit test verifying normalized booking field extraction for CodexFit and MarianaTek.

import { describe, it, expect } from 'vitest';
import { seatNoun, stripClassNamePrefix, trimLocation } from './cards.js';

describe('bookings normalized field handling', () => {
  it('extracts correct metadata from MarianaTek NormalizedBooking', () => {
    const mtBooking = {
      bookingId: '90001',
      eventId: '48900',
      slotId: 'mock-bag-3',
      bookedAt: '2026-09-02T12:00:00Z',
      isWaitlist: false,
      event: {
        id: '48900',
        gymId: 'jab-boxing',
        name: 'BOXING Core & Power',
        discipline: 'BOXING',
        startAt: '2026-09-05T09:00:00Z',
        durationMin: 60,
        endAt: '2026-09-05T10:00:00Z',
        releaseAt: '2026-08-22T09:00:00Z',
        locationId: '48751',
        locationName: 'SW1',
        studioId: 'mock-room-BOXING',
        studioName: 'BOXING',
        instructors: [{ id: '7197', name: 'George Davies' }],
        layoutFormat: 'pick-a-spot',
      },
      raw: {
        id: '90001',
        spot: { id: 'mock-bag-3', name: 'B3' }
      }
    };

    const event = mtBooking.event;
    expect(event.startAt).toBe('2026-09-05T09:00:00Z');
    expect(event.name).toBe('BOXING Core & Power');
    expect(event.discipline).toBe('BOXING');
    expect(event.instructors[0].name).toBe('George Davies');
    expect(event.studioName).toBe('BOXING');
    expect(event.locationName).toBe('SW1');

    const slotLabel = mtBooking.raw?.spot?.name ?? mtBooking.slotId;
    expect(slotLabel).toBe('B3');

    const noun = seatNoun(event.discipline);
    expect(noun).toBe('spot');
  });

  it('extracts correct metadata from CodexFit NormalizedBooking', () => {
    const cfBooking = {
      bookingId: '8255409',
      eventId: '5040',
      slotId: '53',
      bookedAt: '2026-09-01T12:00:00Z',
      isWaitlist: false,
      event: {
        id: '5040',
        gymId: 'psycle-london',
        name: 'RIDE 45',
        discipline: 'RIDE',
        startAt: '2026-09-08T17:30:00Z',
        durationMin: 45,
        endAt: '2026-09-08T18:15:00Z',
        releaseAt: '2026-09-01T12:00:00Z',
        locationId: '1',
        locationName: 'Mortimer Street',
        studioId: '138',
        studioName: 'Ride Studio',
        instructors: [{ id: '20', name: 'Becky' }],
        layoutFormat: 'pick-a-spot',
      },
      raw: {
        id: '8255409',
        studio_slot: { id: 53, label: '14' }
      }
    };

    const event = cfBooking.event;
    expect(event.startAt).toBe('2026-09-08T17:30:00Z');
    expect(event.name).toBe('RIDE 45');
    expect(event.discipline).toBe('RIDE');
    expect(event.instructors[0].name).toBe('Becky');
    expect(event.studioName).toBe('Ride Studio');
    expect(event.locationName).toBe('Mortimer Street');

    const slotLabel = cfBooking.raw?.studio_slot?.label ?? cfBooking.slotId;
    expect(slotLabel).toBe('14');

    const noun = seatNoun(event.discipline);
    expect(noun).toBe('bike');
  });
});
