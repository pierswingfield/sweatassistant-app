import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { COPY } from '../copy.js';
import { GUEST_ACTION_LABEL } from './grouped-cancellation.js';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');

describe('guest action copy', () => {
  it('is exactly "Guest" in both locations', () => {
    expect(COPY.bookings.guestMenu).toBe('Guest');
    expect(GUEST_ACTION_LABEL).toBe('Guest');
  });

  it('never renders "Book Guest" as an action label, and keeps the plus icon', () => {
    const bookings = read('./bookings.js');
    const timetable = read('./timetable.js');
    for (const src of [bookings, timetable, read('../copy.js')]) {
      expect(src).not.toMatch(/Book Guest/);
      expect(src).not.toMatch(/label:\s*COPY\.bookings\.bookGuest/);
    }
    expect(bookings).toMatch(/bk-guest-btn[^`]*\$\{icon\('plus'/);
    expect(timetable).toMatch(/label: COPY\.bookings\.guestMenu, icon: 'userPlus'/);
  });
});
