import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/ui/bookings.js', 'utf8');

describe('auto-upgrade setup shared spot map', () => {
  it('does not restrict selection to available slots', () => {
    const start = src.indexOf('const showMap = ()');
    const call = src.slice(start, src.indexOf('aboveMap:', start));
    expect(call).not.toMatch(/availableSlots\s*:/);
  });
  it('cancel-spots modal renders spots as shared chips', () => {
    expect(src).toMatch(/class="ab-spot-upgrade-chip\$\{isGuest/);
  });
});
