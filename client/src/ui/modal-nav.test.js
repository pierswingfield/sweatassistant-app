import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openPage, closePage, pushLayer, isMobile, openPageCount, _resetForTests } from './modal-nav.js';

function mkModal(id) {
  const el = document.createElement('div');
  el.id = id; el.className = 'app-modal'; el.style.display = 'none';
  el.innerHTML = '<div class="app-modal-overlay"></div><div class="app-modal-card"><div class="app-modal-header"><h4>T</h4><button class="app-modal-close-btn">x</button></div><div class="app-modal-body"></div></div>';
  document.body.appendChild(el);
  return el;
}
const setMobile = (m) => { window.matchMedia = (q) => ({ matches: m, media: q, addEventListener() {}, removeEventListener() {} }); };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { document.body.innerHTML = ''; document.body.removeAttribute('style'); _resetForTests(); history.replaceState(null, ''); window.scrollTo = vi.fn(); });

describe('modal-nav', () => {
  it('desktop: keeps the old display + .show contract, no history/lock', async () => {
    setMobile(false);
    const el = mkModal('a'); const len = history.length;
    openPage(el, { id: 'a' });
    await tick();
    expect(isMobile()).toBe(false);
    expect(el.style.display).toBe('flex');
    expect(el.classList.contains('show')).toBe(true);
    expect(el.classList.contains('app-page')).toBe(false);
    expect(history.length).toBe(len);
    expect(document.body.classList.contains('app-scroll-locked')).toBe(false);
  });

  it('mobile: pushes history, locks scroll, sets dialog semantics, back closes', async () => {
    setMobile(true);
    const el = mkModal('b'); const onClose = vi.fn();
    openPage(el, { id: 'b', onClose });
    await tick();
    expect(el.classList.contains('app-page')).toBe(true);
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(history.state.appNavId).toBe('b');
    expect(document.body.classList.contains('app-scroll-locked')).toBe(true);
    expect(openPageCount()).toBe(1);
    history.back();
    await tick(50);
    expect(openPageCount()).toBe(0);
    expect(onClose).toHaveBeenCalled();
    expect(document.body.classList.contains('app-scroll-locked')).toBe(false);
  });

  it('mobile: locks and restores the isolated app-body scroll position', async () => {
    setMobile(true);
    const scroller = document.createElement('main');
    scroller.className = 'app-body';
    scroller.scrollTop = 87;
    document.body.appendChild(scroller);
    const el = mkModal('scroll-lock');

    openPage(el, { id: 'scroll-lock' });
    await tick();
    expect(scroller.classList.contains('app-scroll-locked')).toBe(true);
    expect(scroller.scrollTop).toBe(87);

    history.back();
    await tick(50);
    expect(scroller.classList.contains('app-scroll-locked')).toBe(false);
    expect(scroller.scrollTop).toBe(87);
  });

  it('mobile timetable: locks and restores the inner class-content scroller', async () => {
    setMobile(true);
    const scroller = document.createElement('main');
    scroller.className = 'app-body app-timetable-active';
    const grid = document.createElement('div');
    grid.className = 'app-timetable-list';
    grid.scrollTop = 231;
    scroller.appendChild(grid);
    document.body.appendChild(scroller);
    const el = mkModal('timetable-scroll-lock');

    openPage(el, { id: 'timetable-scroll-lock' });
    await tick();
    expect(scroller.classList.contains('app-scroll-locked')).toBe(false);
    expect(grid.classList.contains('app-scroll-locked')).toBe(true);
    expect(grid.scrollTop).toBe(231);

    history.back();
    await tick(50);
    expect(grid.classList.contains('app-scroll-locked')).toBe(false);
    expect(grid.scrollTop).toBe(231);
  });

  it('mobile: X goes through history.back and the dirty guard can veto', async () => {
    setMobile(true);
    const el = mkModal('c'); let dirty = true;
    openPage(el, { id: 'c', canClose: () => !dirty });
    await tick();
    el.querySelector('.app-modal-close-btn').click();
    await tick(50);
    expect(openPageCount()).toBe(1);
    dirty = false;
    el.querySelector('.app-modal-close-btn').click();
    await tick(50);
    expect(openPageCount()).toBe(0);
  });

  it('mobile: Escape closes the topmost page; scroll lock is counted across nesting', async () => {
    setMobile(true);
    const a = mkModal('d'); const b = mkModal('e');
    openPage(a, { id: 'd' }); openPage(b, { id: 'e' });
    await tick();
    expect(openPageCount()).toBe(2);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(50);
    expect(openPageCount()).toBe(1);
    expect(document.body.classList.contains('app-scroll-locked')).toBe(true);
    history.back();
    await tick(50);
    expect(openPageCount()).toBe(0);
    expect(document.body.classList.contains('app-scroll-locked')).toBe(false);
  });

  it('closePage on an unregistered element is a no-op', () => {
    expect(() => closePage(document.createElement('div'))).not.toThrow();
  });

  it('layers: back dismisses the layer only; release pops its entry; desktop is a no-op', async () => {
    setMobile(true);
    const el = mkModal('f'); openPage(el, { id: 'f' });
    const onBack = vi.fn();
    const layer = pushLayer({ id: 'dlg', onBack });
    await tick();
    expect(openPageCount()).toBe(2);
    history.back();
    await tick(50);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(openPageCount()).toBe(1);          // the page beneath stays
    const again = pushLayer({ id: 'dlg2', onBack });
    again.release();                           // programmatic dismissal
    await tick(50);
    expect(openPageCount()).toBe(1);
    layer.release();                           // already gone: harmless
    setMobile(false);
    expect(() => pushLayer({}).release()).not.toThrow();
  });

  it('a canClose that vetoes keeps the page open and re-pushes its entry (in-flight checkout)', async () => {
    setMobile(true);
    const el = mkModal('g');
    let busy = true;
    openPage(el, { id: 'g', canClose: () => !busy });
    await tick();
    history.back();
    await tick(60);
    expect(openPageCount()).toBe(1);
    expect(history.state.appNavId).toBe('g');
    busy = false;
    history.back();
    await tick(60);
    expect(openPageCount()).toBe(0);
  });

  it('replaceEl: the new page takes over the old page\'s history slot (no extra entry, Back leaves the flow)', async () => {
    setMobile(true);
    const a = mkModal('h'); const b = mkModal('i');
    const onCloseA = vi.fn();
    openPage(a, { id: 'h', onClose: onCloseA });
    await tick();
    const depthBefore = history.state.appNavDepth;
    openPage(b, { id: 'i', replaceEl: a });
    await tick();
    expect(openPageCount()).toBe(1);
    expect(history.state.appNavId).toBe('i');
    expect(history.state.appNavDepth).toBe(depthBefore);
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('app-scroll-locked')).toBe(true);
    history.back();
    await tick(60);
    expect(openPageCount()).toBe(0);
    expect(document.documentElement.classList.contains('app-scroll-locked')).toBe(false);
  });

  it('a layer that captures the header gets the X/Back click, guarded by its canClose', async () => {
    setMobile(true);
    const el = mkModal('j');
    openPage(el, { id: 'j' });
    let dirty = true;
    const onBack = vi.fn();
    pushLayer({ id: 'j-sub', captureHeader: true, canClose: () => !dirty, onBack });
    await tick();
    el.querySelector('.app-modal-close-btn').click();
    await tick(60);
    expect(onBack).not.toHaveBeenCalled();     // vetoed
    expect(openPageCount()).toBe(2);
    dirty = false;
    el.querySelector('.app-modal-close-btn').click();
    await tick(60);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(openPageCount()).toBe(1);           // the page itself stays
  });
});
