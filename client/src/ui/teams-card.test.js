// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { teamCardModel, teamCardHtml, teamCardAria } from './teams-card.js';
import { pitchRows, pitchHtml } from './teams-pitch.js';
import { renderHomeTeams } from './home-teams.js';
import { escapeHtml } from '../escape-html.js';
import { COPY } from '../copy.js';

const copy = COPY.teams;
const fmt = (t, v = {}) => String(t).replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '');
const when = (iso) => ({ time: iso.slice(11, 16), day: 'Wed', isToday: iso.startsWith('2026-11-10') });
const gymName = (id) => ({ g1: 'JAB Shoreditch' }[id] || '');
const countLabel = (n) => (n === 1 ? '1 member' : `${n} members`);
const base = { id: 'abc', name: 'Run Club', emoji: '🏃', myRole: 'member', memberCount: 4, today: { total: 2, done: 1, inProgress: 0, remaining: 1 } };
const model = (over = {}) => teamCardModel({ ...base, ...over }, { when, copy, gymName, memberCountLabel: countLabel });
const ui = {
  escapeHtml, copy, fmt,
  mascotHtml: () => '<span class="tm-mascot"></span>',
  avatarStackHtml: () => '<span class="tm-stack"></span>',
  segmentsHtml: (segs) => segs.map((s) => escapeHtml(s.text)).join(' · '),
};

describe('Team card model (T9)', () => {
  it('orders: name, member count and role, activity, next class', () => {
    const m = model({ myRole: 'captain', today: { ...base.today, upNext: { gymId: 'g1', className: 'Train', startAt: '2026-11-10T18:30:00Z', timeZone: 'Europe/London' } } });
    expect(m.countLabel).toBe('4 members');
    expect(m.isCaptain).toBe(true);
    expect(m.activityText).toBe('2 classes today · 1 done');
    expect(m.next.text).toBe('Train · Today 18:30 · JAB Shoreditch');
  });
  it('next class names class, time and gym only, never a person', () => {
    const m = model({ today: { total: 0, next: { name: 'John', count: 1 }, solo: { name: 'Zed' },
      upNext: { gymId: 'g1', className: 'Ride', startAt: '2026-11-12T07:30:00Z', name: 'John', count: 3, attendees: ['x'] } } });
    expect(m.next.text).toBe('Ride · Wed 07:30 · JAB Shoreditch');
    expect(JSON.stringify(m)).not.toMatch(/John|Zed/);
    expect(m.activityText).toBe('Rest day');
  });
  it('falls back to the location name, and shows no next line without one', () => {
    expect(model({ today: { upNext: { locationName: 'Soho', className: 'Ride', startAt: '2026-11-12T07:30:00Z' } } }).next.gym).toBe('Soho');
    expect(model().next).toBeNull();
  });
  it('a hidden Team shows only that, with no next class', () => {
    const m = model({ paused: true, today: { upNext: { className: 'Ride', startAt: '2026-11-12T07:30:00Z' } } });
    expect(m.activityText).toBe(copy.hiddenFromTeam);
    expect(m.next).toBeNull();
  });
  it('no stock emoji in card copy (the Team emoji is its own)', () => {
    expect(copy.allDone).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(model({ today: { total: 1, done: 1, remaining: 0, inProgress: 0 } }).activityText).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('Team card markup (T9)', () => {
  const html = (over, extras = '') => teamCardHtml(model(over), ui, { extras });
  const dom = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d; };

  it('the whole card is ONE link with no interactive element nested inside it', () => {
    const d = dom(html({ today: { ...base.today, upNext: { className: 'Ride', startAt: '2026-11-12T07:30:00Z', gymId: 'g1' } } }, '<button class="tm-pin">pin</button>'));
    const link = d.querySelector('a.tcard-link');
    expect(link.getAttribute('href')).toBe('/teams/abc');
    expect(link.querySelectorAll('a, button, input, select, textarea, [tabindex]').length).toBe(0);
    expect(d.querySelector('article > button.tm-pin')).not.toBeNull(); // sibling, not nested
    expect(d.querySelectorAll('a').length).toBe(1);
    expect(link.getAttribute('aria-label')).toBe(teamCardAria(model({ today: { ...base.today, upNext: { className: 'Ride', startAt: '2026-11-12T07:30:00Z', gymId: 'g1' } } }), copy, fmt));
  });
  it('escapes the name, emoji, class and gym', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const h = teamCardHtml(teamCardModel({ ...base, id: 'a"b', name: evil, emoji: '"><b>', today: { upNext: { className: evil, startAt: '2026-11-12T07:30:00Z', locationName: evil } } },
      { when, copy, gymName, memberCountLabel: countLabel }), ui);
    expect(h).not.toContain('<img');
    expect(h).toContain('&quot;&gt;&lt;b&gt;');
    expect(h).toContain('&lt;img');
    expect(h).toContain('href="/teams/a%22b"');
  });
  it('the Home widget renders the same card, clickable as a whole', () => {
    const el = document.createElement('div');
    let opened = null;
    const rows = [model()];
    renderHomeTeams(el, rows, { ui: { T: copy, fmt, mascotHtml: ui.mascotHtml, avatarStackHtml: ui.avatarStackHtml, segmentsHtml: ui.segmentsHtml, escapeHtml }, onOpen: (id) => { opened = id; } });
    expect(el.querySelectorAll('article.tcard.is-compact').length).toBe(1);
    el.querySelector('a[data-home-team]').click();
    expect(opened).toBe('abc');
  });
});

describe('Teams marketing empty state (T9)', () => {
  it('has two benefit rows, a privacy line and the Create action', () => {
    expect(pitchRows(copy).map((r) => r.icon)).toEqual(['book', 'goal']);
    const d = document.createElement('div');
    d.innerHTML = pitchHtml(copy, { escapeHtml, mascotHtml: ui.mascotHtml });
    expect(d.querySelectorAll('.tm-pitch-row svg').length).toBe(2);
    expect(d.querySelector('.tm-pitch-privacy').textContent).toContain('only people in your Team');
    expect(d.querySelector('[data-create]').textContent).toBe(copy.createATeam);
    expect(d.querySelector('.tm-orb')).not.toBeNull();
  });
});
