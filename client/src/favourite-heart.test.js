import { describe, it, expect } from 'vitest';
import { heartButtonHtml } from './favourite-heart.js';

describe('heartButtonHtml (F-12 timetable heart)', () => {
  it('renders a real button with aria-pressed false and an outline heart when not a favourite', () => {
    const h = heartButtonHtml({ isFavourite: false, eventId: 7, label: 'Favourite', pressedLabel: 'Unfavourite' });
    expect(h).toContain('<button type="button"');
    expect(h).toContain('aria-pressed="false"');
    expect(h).toContain('aria-label="Favourite"');
    expect(h).toContain('unbookmarked');
    expect(h).toContain('fill="none"');
    expect(h).toContain('data-event-id="7"');
  });
  it('renders filled and pressed when a favourite', () => {
    const h = heartButtonHtml({ isFavourite: true, eventId: 7, label: 'Favourite', pressedLabel: 'Unfavourite' });
    expect(h).toContain('aria-pressed="true"');
    expect(h).toContain('aria-label="Unfavourite"');
    expect(h).toContain('class="psycle-timetable-heart bookmarked"');
    expect(h).toContain('fill="currentColor"');
  });
  it('escapes ids and labels', () => {
    const h = heartButtonHtml({ isFavourite: false, eventId: '"><x', label: 'a"b', pressedLabel: 'c' });
    expect(h).not.toContain('"><x');
    expect(h).not.toContain('a"b');
  });
  it('accepts an extra class for the mobile card', () => {
    expect(heartButtonHtml({ isFavourite: false, eventId: 1, label: 'x', pressedLabel: 'y', extraClass: 'is-mobile' })).toContain('psycle-timetable-heart unbookmarked is-mobile');
  });
});
