// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNav } from './nav-controller.js';
import { parseLocation } from './url-state.js';

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const setMobile = (m) => { window.matchMedia = (q) => ({ matches: m, media: q, addEventListener() {}, removeEventListener() {} }); };
const route = (p) => parseLocation(p.split('?')[0], p.includes('?') ? `?${p.split('?')[1]}` : '');
let nav; let handled;

function start(mode, url) {
  history.replaceState(null, '', url);
  nav = createNav({ mode });
  handled = [];
  nav.setRouteHandler((r) => handled.push(`${r.tab}${r.section ? `/${r.section}` : ''}`));
  return nav.boot();
}
beforeEach(() => { setMobile(true); sessionStorage.clear(); });
afterEach(() => { nav?._dispose(); });

describe('sync mode (browser tab, Android)', () => {
  it('a deep link builds the parent chain: history depth equals stack depth', async () => {
    await start('sync', '/settings/gym-jab');
    expect(nav.depth()).toBe(3);
    expect(history.state.appNavDepth).toBe(3);
    expect(location.pathname).toBe('/settings/gym-jab');
  });

  it('browser back pops exactly one level at a time, a tab root goes Home first', async () => {
    await start('sync', '/settings/gym-jab');
    history.back(); await tick();
    expect(location.pathname).toBe('/settings/gyms');
    expect(nav.depth()).toBe(2);
    history.back(); await tick();
    expect(location.pathname).toBe('/settings');
    history.back(); await tick();
    expect(location.pathname).toBe('/');
    expect(nav.depth()).toBe(0);
    expect(handled).toEqual(['settings/gyms', 'settings', 'home']);
  });

  it('a tab switch re-bases: depth always equals the stack, and Back goes Home', async () => {
    await start('sync', '/settings/gym-jab');
    nav.routeTo(route('/timetable'), { url: '/timetable' });
    await nav.idle(); await tick();
    expect(location.pathname).toBe('/timetable');
    expect(nav.depth()).toBe(1);
    expect(history.state.appNavDepth).toBe(1);
    history.back(); await tick();
    expect(location.pathname).toBe('/');
    expect(handled).toEqual(['home']);
  });

  it('tab to tab from a root never needs history.go()', async () => {
    await start('sync', '/timetable');
    const len = history.length;
    nav.routeTo(route('/bookings'), { url: '/bookings' });
    expect(location.pathname).toBe('/bookings'); // synchronous
    expect(history.length).toBe(len);
    expect(nav.depth()).toBe(1);
  });

  it('a drill-down pushes one entry and the nav Back pops it without double popping', async () => {
    await start('sync', '/settings');
    nav.routeTo(route('/settings/account'), { url: '/settings/account' });
    expect(nav.depth()).toBe(2);
    await nav.back();
    await tick();
    expect(location.pathname).toBe('/settings');
    expect(nav.depth()).toBe(1);
    expect(handled).toEqual(['settings']);
  });

  it('a page is a level: close pops it, runs onPop once, and the route below is untouched', async () => {
    await start('sync', '/timetable');
    const onPop = vi.fn();
    nav.push({ kind: 'page', key: 'booking', onPop });
    expect(nav.depth()).toBe(2);
    history.back(); await tick();
    expect(onPop).toHaveBeenCalledTimes(1);
    expect(nav.depth()).toBe(1);
    expect(location.pathname).toBe('/timetable');
    expect(handled).toEqual([]); // no route repaint for an overlay
  });

  it('a refused guard keeps the page open and restores history', async () => {
    await start('sync', '/timetable');
    const onPop = vi.fn();
    nav.push({ kind: 'page', key: 'edit', onPop, canClose: () => false });
    history.back(); await tick();
    expect(onPop).not.toHaveBeenCalled();
    expect(nav.depth()).toBe(2);
    expect(history.state.appNavDepth).toBe(2);
  });

  it('a route change closes open pages (no stale overlay)', async () => {
    await start('sync', '/timetable');
    const onPop = vi.fn();
    nav.push({ kind: 'page', key: 'booking', onPop });
    nav.routeTo(route('/bookings'), { url: '/bookings' });
    await nav.idle(); await tick();
    expect(onPop).toHaveBeenCalledTimes(1);
    expect(nav.depth()).toBe(1);
    expect(location.pathname).toBe('/bookings');
  });

  it('Back at Home has nowhere to go', async () => {
    await start('sync', '/');
    expect(nav.canGoBack()).toBe(false);
    expect(await nav.back()).toBe(false);
  });
});

describe('flat mode (iOS standalone)', () => {
  it('never adds a history entry, for drill-downs, pages or tab switches', async () => {
    await start('flat', '/');
    const len = history.length;
    nav.routeTo(route('/settings/account'), { url: '/settings/account' });
    nav.push({ kind: 'page', key: 'p', onPop() {} });
    nav.routeTo(route('/teams/abcdefgh1'), { url: '/teams/abcdefgh1' });
    expect(history.length).toBe(len);
    expect(location.pathname).toBe('/teams/abcdefgh1');
  });

  it('Back is applied to the stack directly and repaints the parent', async () => {
    await start('flat', '/settings/account');
    expect(nav.canGoBack()).toBe(true);
    await nav.back();
    await tick();
    expect(location.pathname).toBe('/settings');
    expect(handled).toEqual(['settings']);
    expect(nav.canGoBack()).toBe(false); // tab root: no gesture, no header Back
  });

  it('a page closes with the same onPop context the gesture asks for', async () => {
    await start('flat', '/bookings');
    const onPop = vi.fn();
    nav.push({ kind: 'page', key: 'x', onPop });
    await nav.back({ source: 'gesture', instant: true });
    await tick();
    expect(onPop).toHaveBeenCalledWith(expect.objectContaining({ instant: true, source: 'gesture' }));
  });

  it('a stray popstate is re-flattened from the URL', async () => {
    await start('flat', '/settings/account');
    history.replaceState(null, '', '/bookings');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await tick();
    expect(nav.depth()).toBe(0);
    expect(handled).toEqual(['my-bookings']);
  });
});
