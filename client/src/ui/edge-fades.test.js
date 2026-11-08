import { describe, expect, it } from 'vitest';
import { scrollEdges } from './edge-fades.js';
describe('hidden horizontal content edges', () => {
  it('does not fade a strip that fits, including the subpixel tolerance', () => {
    expect(scrollEdges({ scrollWidth: 201, clientWidth: 200 })).toEqual({ left: false, right: false });
  });
  it('fades only hidden edges at the start, middle and end', () => {
    const size = { scrollWidth: 500, clientWidth: 200 };
    expect(scrollEdges({ ...size, scrollLeft: 0 })).toEqual({ left: false, right: true });
    expect(scrollEdges({ ...size, scrollLeft: 150 })).toEqual({ left: true, right: true });
    expect(scrollEdges({ ...size, scrollLeft: 300 })).toEqual({ left: true, right: false });
    expect(scrollEdges({ ...size, scrollLeft: -10 })).toEqual({ left: false, right: true });
  });
  it('normalizes RTL negative scroll positions', () => {
    expect(scrollEdges({ scrollWidth: 500, clientWidth: 200, scrollLeft: 0, rtl: true })).toEqual({ left: true, right: false });
    expect(scrollEdges({ scrollWidth: 500, clientWidth: 200, scrollLeft: -300, rtl: true })).toEqual({ left: false, right: true });
  });
});
