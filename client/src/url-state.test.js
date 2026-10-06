import { describe, it, expect } from 'vitest';
import {
  parseLocation, serializeState, isDeepLink, sameState, legacyHashToPath, splitScoped, MAX_LIST, buildTimetableUrl,
} from './url-state.js';

const TABS = ['home', 'class-timetable', 'my-bookings', 'auto-book', 'buy-credits', 'settings'];

describe('paths', () => {
  it('maps every tab to a clean path and back', () => {
    const paths = { home: '/', 'class-timetable': '/timetable', 'my-bookings': '/bookings', 'auto-book': '/auto-book', 'buy-credits': '/credits', settings: '/settings' };
    for (const t of TABS) {
      expect(serializeState({ tab: t })).toBe(paths[t]);
      const p = parseLocation(paths[t], '');
      expect(p.tab).toBe(t);
      expect(p.valid).toBe(true);
    }
  });
  it('/ is Home', () => expect(parseLocation('/', '').tab).toBe('home'));
  it('tolerates trailing slash, case and double slashes', () => {
    expect(parseLocation('/Timetable/', '').tab).toBe('class-timetable');
    expect(parseLocation('//bookings', '').tab).toBe('my-bookings');
  });
  it('unknown paths are invalid and fall to home', () => {
    for (const p of ['/nope', '/api/health', '/timetable/x', '/__proto__', '/constructor', '/settings/a/b']) {
      const r = parseLocation(p, '');
      expect(r.valid).toBe(false);
      expect(r.tab).toBe('home');
    }
  });
  it('settings sections', () => {
    expect(parseLocation('/settings/about', '')).toMatchObject({ tab: 'settings', section: 'about' });
    expect(parseLocation('/settings/gym-jab-boxing', '').section).toBe('gym-jab-boxing');
    expect(serializeState({ tab: 'settings', section: 'gym-psycle-london' })).toBe('/settings/gym-psycle-london');
    expect(parseLocation('/settings/<script>', '').section).toBe(null);
    expect(parseLocation('/settings/..%2f..', '').section).toBe(null);
    expect(serializeState({ tab: 'settings', section: '../x' })).toBe('/settings');
  });
});

describe('timetable params', () => {
  it('parses all params', () => {
    const r = parseLocation('/timetable', '?day=2026-10-07&gym=jab,psycle-london&loc=jab:12&type=psycle-london:ride&instructor=psycle-london:123&fav=1&q=boxing');
    expect(r.timetable).toEqual({
      day: '2026-10-07', gyms: ['jab', 'psycle-london'], locations: ['jab:12'], types: ['psycle-london:ride'],
      instructors: ['psycle-london:123'], fav: true, q: 'boxing', explicit: false,
    });
  });
  it('f=all is explicit only with no other filters', () => {
    expect(parseLocation('/timetable', '?f=all').timetable.explicit).toBe(true);
    expect(parseLocation('/timetable', '?f=all&fav=1').timetable.explicit).toBe(false);
    expect(parseLocation('/timetable', '').timetable.explicit).toBe(false);
  });
  it('params ignored off the timetable', () => {
    expect(isDeepLink(parseLocation('/bookings', '?gym=jab'))).toBe(false);
  });
  it('rejects bare instructor ids and malformed tokens', () => {
    const t = parseLocation('/timetable', '?instructor=123,psycle-london:9,:7,jab:&loc=nogym').timetable;
    expect(t.instructors).toEqual(['psycle-london:9']);
    expect(t.locations).toEqual([]);
  });
  it('splits gym:id on the first colon only', () => {
    expect(splitScoped('jab:a:b')).toEqual({ gymId: 'jab', id: 'a:b' });
    expect(splitScoped('jab')).toBe(null);
  });
  it('validates dates', () => {
    for (const d of ['2026-02-30', '2026-13-01', '26-10-07', '2026-10-7', 'tomorrow', '']) {
      expect(parseLocation('/timetable', `?day=${d}`).timetable.day).toBe(null);
    }
    expect(parseLocation('/timetable', '?day=2028-02-29').timetable.day).toBe('2028-02-29');
  });
  it('de-dupes and caps lists', () => {
    const many = Array.from({ length: 200 }, (_, i) => `g${i}`).join(',');
    expect(parseLocation('/timetable', `?gym=${many}`).timetable.gyms.length).toBe(MAX_LIST);
    expect(parseLocation('/timetable', '?gym=jab,jab,jab').timetable.gyms).toEqual(['jab']);
  });
  it('survives hostile input without throwing', () => {
    const nasty = ['?gym=%E0%A4%A', '?q=' + 'x'.repeat(5000), '?q=%00%1f<img src=x onerror=alert(1)>', '?loc=__proto__:1,constructor:2', '?day[]=1&gym[]=x', '?%=%', '?gym=' + encodeURIComponent('a b;drop table')];
    for (const s of nasty) {
      expect(() => parseLocation('/timetable', s)).not.toThrow();
      const t = parseLocation('/timetable', s).timetable;
      expect(t.q.length).toBeLessThanOrEqual(100);
      expect(t.q).not.toMatch(/[\u0000-\u001f]/);
    }
    expect(() => parseLocation(null, null)).not.toThrow();
    expect(() => parseLocation('/%E0%A4%A', '')).not.toThrow();
    expect(() => serializeState(null)).not.toThrow();
    expect(() => serializeState({ tab: '__proto__', timetable: { gyms: [null, {}, 5] } })).not.toThrow();
    expect(serializeState({ tab: '__proto__' })).toBe('/');
  });
});

describe('round trip', () => {
  it('serialize -> parse is stable over generated states', () => {
    const gyms = [[], ['jab'], ['psycle-london', 'jab']];
    const locs = [[], ['jab:12'], ['psycle-london:3', 'jab:a:b']];
    const insts = [[], ['psycle-london:123']];
    const days = [null, '2026-10-07', '2028-02-29'];
    const qs = ['', 'boxing', 'a b&c=d,e é'];
    let n = 0;
    for (const g of gyms) for (const l of locs) for (const i of insts) for (const d of days) for (const q of qs) for (const fav of [false, true]) for (const explicit of [false, true]) {
      const timetable = { day: d, gyms: g, locations: l, types: [], instructors: i, fav, q, explicit };
      const url = serializeState({ tab: 'class-timetable', timetable });
      const [path, search = ''] = url.split('?');
      const back = parseLocation(path, search ? `?${search}` : '');
      const anyFilter = g.length || l.length || i.length || fav || q;
      expect(back.timetable).toEqual({ ...timetable, explicit: explicit && !anyFilter });
      expect(serializeState(back)).toBe(url); // idempotent
      n++;
    }
    expect(n).toBeGreaterThan(300);
  });
  it('stable param order', () => {
    const url = serializeState({ tab: 'class-timetable', timetable: { q: 'x', fav: true, instructors: ['a:1'], gyms: ['a'], day: '2026-10-07' } });
    expect(url).toBe('/timetable?day=2026-10-07&gym=a&instructor=a%3A1&fav=1&q=x');
  });
  it('sameState / isDeepLink', () => {
    expect(sameState({ tab: 'home' }, { tab: 'home', section: 'x' })).toBe(true);
    expect(sameState({ tab: 'home' }, { tab: 'my-bookings' })).toBe(false);
    expect(isDeepLink(parseLocation('/timetable', '?fav=1'))).toBe(true);
    expect(isDeepLink(parseLocation('/timetable', ''))).toBe(false);
  });
});

describe('legacy hash migration', () => {
  it('maps old hashes', () => {
    expect(legacyHashToPath('#my-bookings')).toBe('/bookings');
    expect(legacyHashToPath('#home')).toBe('/');
    expect(legacyHashToPath('#favourites')).toBe('/settings/favourites'); // F-12 Settings > Favourites pane
    expect(parseLocation('/settings/favourites', '').section).toBe('favourites');
    expect(legacyHashToPath('#class-timetable')).toBe('/timetable');
    expect(legacyHashToPath('#buy-credits')).toBe('/credits');
    expect(legacyHashToPath('#about')).toBe('/settings/about');
    expect(legacyHashToPath('#booking')).toBe('/settings/gyms');
    expect(legacyHashToPath('#advanced')).toBe('/settings/account');
  });
  it('rejects unknown and hostile hashes', () => {
    for (const h of ['', '#', '#nope', '#//evil.com', '#javascript:alert(1)', '#__proto__', '#constructor', null, undefined]) {
      expect(legacyHashToPath(h)).toBe(null);
    }
  });
});

describe('buildTimetableUrl (H link contract)', () => {
  it('builds a stable, parseable link', () => {
    const u = buildTimetableUrl({ gym: ['psycle-london'], instructor: ['psycle-london:123'], day: '2026-10-07' });
    expect(u).toBe('/timetable?day=2026-10-07&gym=psycle-london&instructor=psycle-london%3A123');
    const [p, q] = u.split('?');
    const t = parseLocation(p, `?${q}`).timetable;
    expect(t.instructors).toEqual(['psycle-london:123']);
    expect(t.day).toBe('2026-10-07');
  });
  it('drops bare instructor ids', () => {
    expect(buildTimetableUrl({ instructor: ['123'] })).toBe('/timetable');
  });
});
