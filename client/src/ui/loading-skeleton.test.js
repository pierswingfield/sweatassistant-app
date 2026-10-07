import { describe, expect, it } from 'vitest';
import { renderCardSkeletons, renderTimetableSkeleton } from './loading-skeleton.js';

describe('loading skeletons', () => {
  it('renders the requested number of accessible card placeholders', () => {
    const html = renderCardSkeletons(3, 'Loading bookings');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading bookings"');
    expect((html.match(/app-skeleton-card"/g) || []).length).toBe(3);
  });

  it('renders timetable-shaped rows', () => {
    const html = renderTimetableSkeleton(5);
    expect(html).toContain('aria-label="Loading timetable"');
    expect((html.match(/app-skeleton-table-row"/g) || []).length).toBe(5);
  });
});
