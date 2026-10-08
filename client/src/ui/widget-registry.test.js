import { describe, expect, it, vi } from 'vitest';
import { createRegistry, loadWidgets, mountWidget } from './widget-registry.js';

const w = (id, order, extra = {}) => ({ id, title: id, order, render() {}, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('widget registry', () => {
  it('orders by order then id and honours isVisible', () => {
    const r = createRegistry();
    r.register(w('b', 20)); r.register(w('a', 20)); r.register(w('first', 1)); r.register(w('hidden', 5, { isVisible: () => false }));
    expect(r.list().map((x) => x.id)).toEqual(['first', 'a', 'b']);
  });
  it('rejects a widget without render', () => {
    expect(() => createRegistry().register({ id: 'x' })).toThrow();
  });
  it('isolates a failing widget from the others', async () => {
    const res = await loadWidgets([w('ok', 1, { load: async () => 5 }), w('bad', 2, { load: async () => { throw new Error('x'); } }), w('sync', 3, { load: () => { throw new Error('y'); } })], {});
    expect(res.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(res[0].value).toBe(5);
  });
});

describe('mountWidget states', () => {
  it('shows a skeleton, then renders data', async () => {
    const el = document.createElement('section');
    const render = vi.fn((b, d) => { b.textContent = `n=${d}`; });
    const p = mountWidget(el, w('a', 1, { load: async () => 3, render }), {}, { skeleton: () => '<i class="sk"></i>' });
    expect(el.querySelector('.sk')).toBeTruthy();
    expect(el.dataset.widgetState).toBe('loading');
    await p;
    expect(el.dataset.widgetState).toBe('ready');
    expect(el.textContent).toContain('n=3');
  });
  it('shows the empty state', async () => {
    const el = document.createElement('section');
    await mountWidget(el, w('a', 1, { isEmpty: () => true, emptyText: 'nothing' }), {});
    expect(el.dataset.widgetState).toBe('empty');
    expect(el.textContent).toContain('nothing');
  });
  it('lets an empty widget render its own non-data CTA', async () => {
    const el = document.createElement('section');
    await mountWidget(el, w('a', 1, {
      isEmpty: () => true,
      renderEmpty(body) { body.innerHTML = '<button>View all</button>'; },
    }), {});
    expect(el.dataset.widgetState).toBe('empty');
    expect(el.querySelector('button')?.textContent).toBe('View all');
  });
  it('shows an error and retries only that widget', async () => {
    const el = document.createElement('section');
    let n = 0;
    const load = vi.fn(async () => { if (++n === 1) throw new Error('boom'); return 'ok'; });
    await mountWidget(el, w('a', 1, { load, render(b, d) { b.textContent = d; } }), {}, { copy: { error: 'bad', retry: 'Retry' } });
    expect(el.dataset.widgetState).toBe('error');
    el.querySelector('.home-widget-retry').click();
    await tick(); await tick();
    expect(load).toHaveBeenCalledTimes(2);
    expect(el.dataset.widgetState).toBe('ready');
    expect(el.textContent).toContain('ok');
  });
  it('treats NO_GYM_LINKED as a connect-gym state, not an error', async () => {
    const el = document.createElement('section');
    await mountWidget(el, w('a', 1, { load: async () => { const e = new Error('n'); e.code = 'NO_GYM_LINKED'; throw e; } }), {}, { copy: { noGym: 'connect' } });
    expect(el.querySelector('.home-widget-retry')).toBeNull();
    expect(el.textContent).toContain('connect');
  });
  it('a stale run cannot overwrite a newer one', async () => {
    const el = document.createElement('section');
    let release; const slow = new Promise((r) => { release = r; });
    const p1 = mountWidget(el, w('a', 1, { load: () => slow, render(b) { b.textContent = 'old'; } }), {});
    await mountWidget(el, w('a', 1, { load: async () => 1, render(b) { b.textContent = 'new'; } }), {});
    release(1); await p1;
    expect(el.textContent).toContain('new');
  });
});
