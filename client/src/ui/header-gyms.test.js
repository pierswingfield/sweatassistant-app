import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const HTML = `<header class="app-header"><div class="app-hgym" id="app-hgym" data-mode="plain" data-state="collapsed">
  <div id="app-header-credits" class="app-hgym-strip"></div>
  <button id="app-hgym-ring" hidden aria-expanded="false"><svg><circle class="app-hgym-track"/><circle class="app-hgym-glow"/><circle class="app-hgym-arc"/></svg>
  <span class="app-hgym-attn" hidden></span></button>
  <span id="app-hgym-live" aria-live="polite"></span></div></header>`;
const chips = (n) => Array.from({ length: n }, (_, i) => `<button class="app-header-gym-badge" data-gym="g${i}"></button>`).join('');
const ids = (n) => Array.from({ length: n }, (_, i) => `g${i}`);

let hg, beginGymLoad, endGymLoad, resetGymLoadState;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
  document.body.innerHTML = HTML;
  vi.resetModules();
  ({ beginGymLoad, endGymLoad, resetGymLoadState } = await import('./gym-load-state.js'));
  resetGymLoadState();
  hg = await import('./header-gyms.js');
  hg.initHeaderGyms();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const ring = () => document.getElementById('app-hgym-ring');
const strip = () => document.getElementById('app-header-credits');

describe('header gyms DOM wiring', () => {
  it('4 gyms: plain, ring hidden; 5 gyms: ring shown with the count and a collapsed, inert strip', () => {
    strip().innerHTML = chips(4); hg.syncGyms(ids(4));
    expect(ring().hidden).toBe(true);
    expect(document.getElementById('app-hgym').dataset.mode).toBe('plain');
    strip().innerHTML = chips(5); hg.syncGyms(ids(5));
    expect(ring().hidden).toBe(false);
    expect(ring().querySelector('.app-hgym-count')).toBeNull();
    expect(ring().textContent.trim()).toBe('');
    expect(strip().inert).toBe(true);
    expect(ring().getAttribute('aria-expanded')).toBe('false');
    expect(ring().getAttribute('aria-label')).toBe('Gyms: 5, tap to show');
  });
  it('setting modes', () => {
    strip().innerHTML = chips(5); hg.syncGyms(ids(5));
    hg.setMode('always'); expect(hg.getMode()).toBe('plain'); expect(ring().hidden).toBe(true);
    hg.setMode('never'); strip().innerHTML = chips(1); hg.syncGyms(ids(1));
    expect(hg.getMode()).toBe('collapsible'); expect(ring().hidden).toBe(false);
    hg.setMode('auto'); expect(hg.getMode()).toBe('plain');
  });
  it('tap toggles aria-expanded, un-inerts, then collapses 5 s later', () => {
    strip().innerHTML = chips(5); hg.syncGyms(ids(5));
    ring().click(); vi.advanceTimersByTime(10);
    expect(ring().getAttribute('aria-expanded')).toBe('true');
    expect(ring().getAttribute('aria-label')).toBe('Hide gyms');
    expect(strip().inert).toBe(false);
    vi.advanceTimersByTime(5200);
    expect(document.getElementById('app-hgym').dataset.state).toBe('collapsing');
    vi.advanceTimersByTime(800);
    expect(strip().inert).toBe(true);
    expect(ring().getAttribute('aria-expanded')).toBe('false');
  });
  it('is-muted lives on the container and survives a chip rebuild', () => {
    strip().innerHTML = chips(5); hg.syncGyms(ids(5));
    vi.advanceTimersByTime(4100);
    expect(strip().classList.contains('is-muted')).toBe(true);
    strip().innerHTML = chips(5);
    expect(strip().classList.contains('is-muted')).toBe(true);
    hg.markStrong();
    expect(strip().classList.contains('is-muted')).toBe(false);
  });
  it('warning dot shows only when collapsible and a gym needs attention', () => {
    strip().innerHTML = chips(5); hg.syncGyms(ids(5), true);
    expect(ring().querySelector('.app-hgym-attn').hidden).toBe(false);
    expect(ring().getAttribute('aria-label')).toContain('needs attention');
    hg.syncGyms(ids(5), false);
    expect(ring().querySelector('.app-hgym-attn').hidden).toBe(true);
  });
  it('live region announces at wave start and end only, while collapsed', () => {
    strip().innerHTML = chips(5); hg.syncGyms(ids(5));
    const live = document.getElementById('app-hgym-live');
    beginGymLoad('g0'); beginGymLoad('g1'); vi.advanceTimersByTime(5);
    expect(live.textContent).toBe('Loading gyms');
    endGymLoad('g0'); vi.advanceTimersByTime(5);
    expect(live.textContent).toBe('Loading gyms');
    expect(ring().getAttribute('aria-label')).toBe('Gyms: 5, tap to show. Loading, 1 of 2 done');
    endGymLoad('g1'); vi.advanceTimersByTime(5);
    expect(live.textContent).toBe('All gyms loaded');
  });
});
