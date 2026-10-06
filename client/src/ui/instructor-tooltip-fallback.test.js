import { describe, it, expect, vi } from 'vitest';

vi.mock('./timetable', () => ({ metadata: { instructors: [] } }));
vi.mock('../api', () => ({ api: {} }));

import { instructorTooltipHTML, instructorHoverAttrs } from './tooltips.js';

describe('instructor popup for gyms whose metadata lacks the instructor (MarianaTek)', () => {
  it('builds the popup from the event instructor data when metadata is empty', () => {
    const html = instructorTooltipHTML('abc', 'jab-boxing', { name: 'Sam Rivers', photo: 'https://x/y.jpg' });
    expect(html).toContain('Sam Rivers');
    expect(html).toContain('https://x/y.jpg');
  });
  it('still returns null with neither metadata nor fallback', () => {
    expect(instructorTooltipHTML('abc', 'jab-boxing')).toBeNull();
  });
  it('copes with a missing id (undefined) by using the name', () => {
    expect(instructorTooltipHTML(undefined, 'jab-boxing', { name: 'Sam Rivers' })).toContain('Sam Rivers');
  });
  it('hover attrs carry name and photo from instructors[0]', () => {
    const a = instructorHoverAttrs({ id: 7, name: 'Sam "S" Rivers', thumbUrl: 't.jpg' }, 'jab-boxing');
    expect(a).toContain('data-name="Sam &quot;S&quot; Rivers"');
    expect(a).toContain('data-photo="t.jpg"');
  });
});
