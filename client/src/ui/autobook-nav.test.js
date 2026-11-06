// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { countPendingAutoBooks, autoBookBackAction, bookingsNavActive } from './autobook-nav.js';
import { parseLocation } from '../url-state.js';
import { pathFor } from '../router.js';
import { resolve } from 'node:path';

describe('T8 Auto-Book mobile routing', () => {
  it('Back pops history when the member arrived from any in-app tab (T12: Home included)', () => {
    for (const t of ['my-bookings', 'home', 'class-timetable', 'teams', 'settings']) expect(autoBookBackAction(t)).toBe('history-back');
  });
  it('Back falls back to Bookings when there is no in-app tab behind it (deep link, push click)', () => {
    for (const t of [null, undefined, '', 'auto-book']) expect(autoBookBackAction(t)).toBe('replace-bookings');
  });
  it('a deep link to /auto-book still resolves to the auto-book tab', () => {
    const r = parseLocation('/auto-book');
    expect(r.valid).toBe(true);
    expect(r.tab).toBe('auto-book');
    expect(pathFor({ tab: 'auto-book' })).toBe('/auto-book');
  });
  it('Bookings nav stays highlighted on the Auto-Book page', () => {
    expect(bookingsNavActive('my-bookings')).toBe(true);
    expect(bookingsNavActive('auto-book')).toBe(true);
    expect(bookingsNavActive('home')).toBe(false);
  });
  it('count: not loaded is null, executed rows excluded', () => {
    expect(countPendingAutoBooks(undefined)).toBeNull();
    expect(countPendingAutoBooks([{}, { executed_at: 'x' }, {}])).toBe(2);
  });
  it('markup: no bottom-nav Auto-Book item, desktop top nav keeps it, bar exists', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const start = html.indexOf('<nav class="app-bottom-nav"');
    const bottom = html.slice(start, html.indexOf('</nav>', start));
    expect(bottom).not.toContain('data-tab="auto-book"');
    expect(html.slice(0, start)).toContain('class="app-nav-btn" data-tab="auto-book"');
    expect(html).toContain('id="app-bookings-autobook-bar"');
    expect(html).toContain('id="app-autobook-back-btn"');
  });
});
