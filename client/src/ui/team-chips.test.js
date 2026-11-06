import { describe, it, expect, beforeEach } from 'vitest';
import { buildChipIndex, chipModel, teamChipHtml, namesText, chipKey, loadTeamChips, chipsFor, resetTeamChips, CHIP_STACK_MAX } from './team-chips.js';

const payload = {
  classes: [
    { key: 'psycle-london:101', gymId: 'psycle-london', eventId: '101', teams: [
      { teamId: 'teamAAAAAAAAAAAA', name: 'Tuesday Riders', emoji: null, pinned: true, members: [
        { memberRef: 'r1', name: 'Piers W.', colourIndex: 2 }, { memberRef: 'r2', name: 'Cara J', colourIndex: 5 }] },
      { teamId: 'teamBBBBBBBBBBBB', name: 'Flat 4B', emoji: '🏠', pinned: false, members: [{ memberRef: 'r3', name: 'Lena', colourIndex: 1 }] },
    ] },
    { key: 'jab-boxing:7', gymId: 'jab-boxing', eventId: '7', teams: [] },
    { key: 'bad key', teams: [{ teamId: 'x', name: 'y', members: [{ name: 'z' }] }] },
  ],
};

describe('timetable Team chips (T-5, §5.3)', () => {
  it('indexes by gym-qualified key and drops malformed or empty entries', () => {
    const idx = buildChipIndex(payload);
    expect([...idx.keys()]).toEqual(['psycle-london:101']);
    expect(chipKey({ gymId: 'psycle-london', id: 101 })).toBe('psycle-london:101');
    expect(chipKey({ id: 101 })).toBe('');
    expect(buildChipIndex(null).size).toBe(0);
  });

  it('first Team (server order: pin, then name) + "+1"; initials stack; detail per Team', () => {
    const m = chipModel(buildChipIndex(payload).get('psycle-london:101'));
    expect(m.label).toBe('Tuesday Riders');
    expect(m.more).toBe(1);
    expect(m.avatars).toEqual([{ initials: 'PW', colour: 2 }, { initials: 'CJ', colour: 5 }]);
    expect(m.detail).toEqual([{ team: 'Tuesday Riders', names: 'Piers W. and Cara J' }, { team: '🏠 Flat 4B', names: 'Lena' }]);
    expect(m.aria).toContain('and 1 more Teams');
    expect(chipModel([])).toBeNull();
  });

  it('caps the avatar stack', () => {
    const members = Array.from({ length: 6 }, (_, i) => ({ name: `M${i} X`, colourIndex: i }));
    expect(chipModel([{ teamId: 't', name: 'Big', members }]).avatars).toHaveLength(CHIP_STACK_MAX);
  });

  it('names lists', () => {
    expect(namesText(['Ana'])).toBe('Ana');
    expect(namesText(['Ana', 'Sam'])).toBe('Ana and Sam');
    expect(namesText(['Ana', 'Sam', 'Tom'])).toBe('Ana, Sam and Tom');
    expect(namesText(['Ana', 'Sam', 'Tom', 'Lee'])).toBe('Ana, Sam and 2 more');
  });

  it('escapes every Team and member string; never renders a spot', () => {
    const html = teamChipHtml([{ teamId: 't', name: '<img src=x onerror=1>', members: [{ name: '"><script>x</script>', colourIndex: 0, spot: 'Bike 14' }] }]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('Bike 14');
    expect(teamChipHtml(null)).toBe('');
  });

  describe('per-load index', () => {
    beforeEach(() => resetTeamChips());
    it('fetches once within the TTL and reports changes', async () => {
      let calls = 0;
      const fetcher = async () => { calls++; return payload; };
      expect(await loadTeamChips(fetcher)).toBe(true);
      expect(await loadTeamChips(fetcher)).toBe(false);
      expect(calls).toBe(1);
      expect(chipsFor({ gymId: 'psycle-london', id: '101' })).toHaveLength(2);
      expect(await loadTeamChips(fetcher, { force: true })).toBe(false); // same content
      expect(calls).toBe(2);
    });
    it('a failed fetch keeps the last index', async () => {
      await loadTeamChips(async () => payload);
      expect(await loadTeamChips(async () => { throw new Error('x'); }, { force: true })).toBe(false);
      expect(chipsFor({ gymId: 'psycle-london', id: 101 })).toBeTruthy();
    });
  });
});
