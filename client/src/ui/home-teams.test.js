import { describe, it, expect } from 'vitest';
import { homeTeamsModel, HOME_TEAMS_MAX } from './home-teams.js';
import { COPY } from '../copy.js';

const copy = COPY.teams;
const when = (iso) => ({ time: iso.slice(11, 16), day: 'Wed', isToday: iso.startsWith('2026-11-10') });
const team = (id, over = {}) => ({ id, name: `Team ${id}`, pinned: false, today: { total: 0, done: 0, inProgress: 0, remaining: 0 }, ...over });

describe('Home "Your Teams today" (T-5)', () => {
  it('top two, pinned first, otherwise the server order', () => {
    const rows = homeTeamsModel([team('a'), team('b'), team('c', { pinned: true })], { when, copy });
    expect(rows.map((r) => r.id)).toEqual(['c', 'a']);
    expect(HOME_TEAMS_MAX).toBe(2);
  });
  it('uses the Teams card today line, WITHOUT naming a teammate', () => {
    const [r] = homeTeamsModel([team('a', { today: { total: 0, done: 0, inProgress: 0, remaining: 0,
      next: { when: 'tomorrow', name: 'John', count: 1, startAt: '2026-11-11T08:30:00Z', className: 'Train' } } })], { when, copy });
    expect(r.activityText).toBe('Rest day');
    expect(JSON.stringify(r)).not.toContain('John');
    const [s] = homeTeamsModel([team('b', { today: { total: 3, done: 1, inProgress: 0, remaining: 2 } })], { when, copy });
    expect(s.activityText).toBe('3 classes today · 1 done');
  });
  it('a paused Team says so instead of showing activity', () => {
    const [r] = homeTeamsModel([team('a', { paused: true, today: { total: 3, done: 1, inProgress: 0, remaining: 2 } })], { when, copy });
    expect(r.activityText).toBe(copy.hiddenFromTeam);
  });
  it('no Teams or a bad payload is empty', () => {
    expect(homeTeamsModel(undefined, { when, copy })).toEqual([]);
    expect(homeTeamsModel([{ name: 'no id' }], { when, copy })).toEqual([]);
  });
});
