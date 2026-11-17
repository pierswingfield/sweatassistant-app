// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { countPendingAutoBooks, bookingsNavActive } from './autobook-nav.js';
import { parseLocation } from '../url-state.js';
import { pathFor } from '../router.js';
import { resolve } from 'node:path';

describe('T8 Auto-Book mobile routing', () => {
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

// Back from Auto-Book is nav.back() (parent chain bookings -> auto-book on mobile): see nav-stack.test.js.
