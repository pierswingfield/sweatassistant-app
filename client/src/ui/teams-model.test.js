import { describe, expect, it } from 'vitest';
import {
  AVATAR_PALETTE, avatarColourIndex, initials, orderTeams, canOfferPin, canTogglePin, pinsUsed,
  sortMembers, paginate, readSortChoice, writeSortChoice, DEFAULT_SORT,
  defaultShare, normaliseShare, applyShareChange, shareChips, isIndefinitePause, pauseOptionFor,
  parseTeamsPath, teamsPathFor, inviteUrlOn, stashPendingInvite, peekPendingInvite, clearPendingInvite, PENDING_TTL_MS,
  validateTeamName, validateEmoji, invitePageState, relativeTime,
} from './teams-model.js';

function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };

describe('avatar palette and initials (§5.5)', () => {
  it('has 16 distinct colours matching the server palette size', () => {
    expect(AVATAR_PALETTE).toHaveLength(16);
    expect(new Set(AVATAR_PALETTE).size).toBe(16);
  });
  it('every colour carries white initials at AA (4.5:1) and stays visible on the dark surface', () => {
    for (const c of AVATAR_PALETTE) {
      expect(contrast(c, '#ffffff'), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, '#202020'), c).toBeGreaterThanOrEqual(2);
    }
  });
  it('wraps any index into the palette', () => {
    expect(avatarColourIndex(0)).toBe(0);
    expect(avatarColourIndex(17)).toBe(1);
    expect(avatarColourIndex(-1)).toBe(15);
    expect(avatarColourIndex('3')).toBe(3);
    expect(avatarColourIndex(undefined)).toBe(0);
  });
  it('derives initials from server display names', () => {
    expect(initials('Sam')).toBe('S');
    expect(initials('Sam B.')).toBe('SB');
    expect(initials('Sam B. 2')).toBe('SB');
    expect(initials('  émile  zola ')).toBe('ÉZ');
    expect(initials('Sam B.', 1)).toBe('S');
    expect(initials('')).toBe('?');
    expect(initials('<b>')).toBe('?');
  });
});

describe('Teams list ordering and pinning (§5.2)', () => {
  const t = (id, pinned = false) => ({ id, pinned });
  it('puts pinned Teams first and keeps server order otherwise', () => {
    expect(orderTeams([t('a'), t('b', true), t('c'), t('d', true)]).map((x) => x.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(orderTeams(null)).toEqual([]);
  });
  it('offers pinning only to members of more than 3 Teams, max 2', () => {
    expect(canOfferPin(3)).toBe(false);
    expect(canOfferPin(4)).toBe(true);
    const four = [t('a', true), t('b', true), t('c'), t('d')];
    expect(pinsUsed(four)).toBe(2);
    expect(canTogglePin(four[2], four)).toBe(false); // limit reached
    expect(canTogglePin(four[0], four)).toBe(true); // unpin always allowed
    expect(canTogglePin(t('x'), [t('x'), t('y'), t('z')])).toBe(false);
  });
});

describe('members widget (§5.3)', () => {
  const ms = [
    { memberRef: 'r1', name: 'sam' }, { memberRef: 'r2', name: 'Ana' }, { memberRef: 'r3', name: 'Tom' },
    { memberRef: 'r4', name: 'Priya' }, { memberRef: 'r5', name: 'Josh' },
  ];
  it('sorts by name case-insensitively', () => {
    expect(sortMembers(ms, 'name').map((m) => m.name)).toEqual(['Ana', 'Josh', 'Priya', 'sam', 'Tom']);
  });
  it('sorts by activity, falling back to name (all 0 until T-2)', () => {
    expect(sortMembers(ms, 'activity').map((m) => m.name)).toEqual(['Ana', 'Josh', 'Priya', 'sam', 'Tom']);
    const act = { r3: 5, r1: 2 };
    expect(sortMembers(ms, 'activity', { activityOf: (m) => act[m.memberRef] || 0 }).map((m) => m.name).slice(0, 3)).toEqual(['Tom', 'sam', 'Ana']);
  });
  it('shuffles deterministically per seed and keeps every member', () => {
    const a = sortMembers(ms, 'shuffle', { seed: 'team1:2026-11-04' }).map((m) => m.memberRef);
    const b = sortMembers(ms, 'shuffle', { seed: 'team1:2026-11-04' }).map((m) => m.memberRef);
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    const seeds = new Set(['s1', 's2', 's3', 's4', 's5', 's6'].map((s) => sortMembers(ms, 'shuffle', { seed: s }).map((m) => m.memberRef).join()));
    expect(seeds.size).toBeGreaterThan(1);
  });
  it('pages 4 at a time', () => {
    expect(paginate(ms).map((p) => p.length)).toEqual([4, 1]);
    expect(paginate([])).toEqual([]);
    expect(paginate([1, 2, 3, 4])).toEqual([[1, 2, 3, 4]]);
  });
  it('remembers the sort per Team and survives blocked storage', () => {
    const s = memStorage();
    expect(readSortChoice(s, 'T1')).toBe(DEFAULT_SORT);
    expect(writeSortChoice(s, 'T1', 'activity')).toBe(true);
    expect(readSortChoice(s, 'T1')).toBe('activity');
    expect(readSortChoice(s, 'T2')).toBe(DEFAULT_SORT);
    expect(writeSortChoice(s, 'T1', 'bogus')).toBe(false);
    s.setItem('appTeamMemberSort:T3', 'evil');
    expect(readSortChoice(s, 'T3')).toBe(DEFAULT_SORT);
    expect(readSortChoice(blocked, 'T1')).toBe(DEFAULT_SORT);
    expect(writeSortChoice(blocked, 'T1', 'name')).toBe(false);
  });
});

describe('sharing sheet model (§3)', () => {
  it('starts from the D3 defaults', () => {
    expect(defaultShare()).toEqual({ gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true, spots: false, autoBookQueue: false, competition: false });
  });
  it('normalises missing or bad values to private', () => {
    expect(normaliseShare({ upcoming: 'yes', gyms: 'some' })).toEqual({ gyms: [], upcoming: false, waitlists: false, activity: false, recent: false, spots: false, autoBookQueue: false, competition: false });
    expect(normaliseShare(null).gyms).toEqual([]);
  });
  it('switches gym scope and toggles single gyms', () => {
    const linked = ['psy', 'jab'];
    let s = applyShareChange(defaultShare(), { type: 'gymsMode', mode: 'choose', linked });
    expect(s.gyms).toEqual(['psy', 'jab']);
    s = applyShareChange(s, { type: 'gym', gymId: 'psy', on: false, linked });
    expect(s.gyms).toEqual(['jab']);
    s = applyShareChange(s, { type: 'gym', gymId: 'psy', on: true, linked });
    expect(s.gyms).toEqual(['jab', 'psy']);
    expect(applyShareChange(s, { type: 'gymsMode', mode: 'all' }).gyms).toBe('all');
  });
  it('toggles known keys only', () => {
    const s = applyShareChange(defaultShare(), { type: 'toggle', key: 'spots', on: true });
    expect(s.spots).toBe(true);
    expect(applyShareChange(s, { type: 'toggle', key: 'evil', on: true })).not.toHaveProperty('evil');
    expect(applyShareChange(s, { type: 'toggle', key: 'gyms', on: false }).gyms).toBe('all');
  });
  it('builds overview chips', () => {
    const chips = shareChips({ gyms: ['jab'], upcoming: true, spots: true });
    expect(chips[0]).toEqual({ key: 'gyms', on: true, scope: 'some', gymIds: ['jab'] });
    expect(chips.find((c) => c.key === 'waitlists').on).toBe(false);
    expect(chips.find((c) => c.key === 'spots').on).toBe(true);
    expect(shareChips({ gyms: [] })[0].scope).toBe('none');
  });
  it('recognises the indefinite pause', () => {
    expect(isIndefinitePause('9999-12-31T23:59:59.999Z')).toBe(true);
    expect(isIndefinitePause('2026-11-05T09:00:00.000Z')).toBe(false);
    expect(isIndefinitePause(null)).toBe(false);
  });
  it('maps a pause end back to the option that set it', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(pauseOptionFor(null, now)).toBeNull();
    expect(pauseOptionFor('9999-12-31T23:59:59.999Z', now)).toBe('indefinite');
    expect(pauseOptionFor('2026-11-05T12:00:00Z', now)).toBe('24h');
    expect(pauseOptionFor('2026-11-11T12:00:00Z', now)).toBe('7d');
    expect(pauseOptionFor('2026-11-01T12:00:00Z', now)).toBeNull();
  });
});

describe('routes (§5.6)', () => {
  const token = 'AbC_dEf-123456789XYZab';
  it('parses list, team and invite paths, preserving case', () => {
    expect(parseTeamsPath('/teams')).toEqual({ view: 'list' });
    expect(parseTeamsPath('/teams/')).toEqual({ view: 'list' });
    expect(parseTeamsPath('/teams/AbCdEfGh12_-')).toEqual({ view: 'team', teamId: 'AbCdEfGh12_-' });
    expect(parseTeamsPath(`/t/${token}`)).toEqual({ view: 'invite', token });
    expect(parseTeamsPath(`/t/${token}?x=1`)).toEqual({ view: 'invite', token });
  });
  it('rejects malformed ids and tokens', () => {
    expect(parseTeamsPath('/teams/<script>')).toEqual({ view: 'list' });
    expect(parseTeamsPath('/t/short')).toBeNull();
    expect(parseTeamsPath('/t/abc%2F..%2Fapi')).toBeNull();
    expect(parseTeamsPath('/timetable')).toBeNull();
    expect(parseTeamsPath('/t/')).toBeNull();
  });
  it('serialises back', () => {
    expect(teamsPathFor({ view: 'team', teamId: 'AbCd1234' })).toBe('/teams/AbCd1234');
    expect(teamsPathFor({ view: 'invite', token })).toBe(`/t/${token}`);
    expect(teamsPathFor({ view: 'team', teamId: 'a/b' })).toBe('/teams');
    expect(teamsPathFor(null)).toBe('/teams');
  });
  it('rebuilds invite URLs on the current origin', () => {
    expect(inviteUrlOn('https://dev.example/', `https://localhost/t/${token}`)).toBe(`https://dev.example/t/${token}`);
    expect(inviteUrlOn('https://dev.example', token)).toBe(`https://dev.example/t/${token}`);
    expect(inviteUrlOn('https://dev.example', 'https://evil/x')).toBeNull();
  });
});

describe('pending invite across the auth flow', () => {
  const token = 'AbC_dEf-123456789XYZab';
  it('stores only well-formed tokens and expires them', () => {
    const s = memStorage();
    expect(stashPendingInvite(s, 'bad token')).toBe(false);
    expect(stashPendingInvite(s, token, 1000)).toBe(true);
    expect(peekPendingInvite(s, 2000)).toBe(token);
    expect(peekPendingInvite(s, 1000 + PENDING_TTL_MS)).toBeNull();
    expect(s.getItem('appPendingTeamInvite')).toBeNull();
  });
  it('drops tampered entries and clears', () => {
    const s = memStorage();
    s.setItem('appPendingTeamInvite', JSON.stringify({ t: '../../api', at: Date.now() }));
    expect(peekPendingInvite(s)).toBeNull();
    s.setItem('appPendingTeamInvite', '{not json');
    expect(peekPendingInvite(s)).toBeNull();
    stashPendingInvite(s, token);
    clearPendingInvite(s);
    expect(peekPendingInvite(s)).toBeNull();
    expect(stashPendingInvite(blocked, token)).toBe(false);
    expect(peekPendingInvite(blocked)).toBeNull();
  });
});

describe('validation and labels', () => {
  it('validates Team names like the server', () => {
    expect(validateTeamName('  Tuesday   Riders ')).toEqual({ ok: true, value: 'Tuesday Riders' });
    expect(validateTeamName('').ok).toBe(false);
    expect(validateTeamName('x'.repeat(41))).toEqual({ ok: false, error: 'tooLong' });
    expect(validateTeamName('x'.repeat(40)).ok).toBe(true);
    expect(validateTeamName('<b>hi</b>')).toEqual({ ok: false, error: 'angle' });
  });
  it('accepts exactly one emoji or nothing', () => {
    expect(validateEmoji('')).toEqual({ ok: true, value: null });
    expect(validateEmoji('🚲')).toEqual({ ok: true, value: '🚲' });
    expect(validateEmoji('👨‍👩‍👧').ok).toBe(true);
    expect(validateEmoji('🇬🇧').ok).toBe(true);
    expect(validateEmoji('🚲🚲').ok).toBe(false);
    expect(validateEmoji('a').ok).toBe(false);
  });
  it('maps invite states, never exposing why', () => {
    expect(invitePageState({ myRequestStatus: 'member' })).toBe('member');
    expect(invitePageState({ myRequestStatus: 'pending' })).toBe('pending');
    expect(invitePageState({ myRequestStatus: 'notMember' })).toBe('notMember');
    expect(invitePageState({ myRequestStatus: 'expired' })).toBe('invite');
    expect(invitePageState({ myRequestStatus: 'none' })).toBe('invite');
    expect(invitePageState(null)).toBe('invite');
  });
  it('formats relative times', () => {
    const now = Date.parse('2026-11-04T12:00:00Z');
    expect(relativeTime('2026-11-04T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-11-04T11:50:00Z', now)).toBe('10 min ago');
    expect(relativeTime('2026-11-04T10:00:00Z', now)).toBe('2 h ago');
    expect(relativeTime('2026-11-03T10:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-11-01T10:00:00Z', now)).toBe('3 days ago');
    expect(relativeTime('nope', now)).toBe('');
  });
});
