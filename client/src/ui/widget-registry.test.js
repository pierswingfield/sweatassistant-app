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
  it('suppresses the cold skeleton when every source has cached data', async () => {
    const el = document.createElement('section');
    await mountWidget(el, w('a', 1, { render(b) { b.textContent = 'cached'; } }), {}, {
      skeleton: () => '<i class="sk"></i>', hasCachedData: async () => true,
    });
    expect(el.querySelector('.sk')).toBeNull();
    expect(el.textContent).toContain('cached');
  });
  it('retains the last content through a same-context refresh and failure', async () => {
    const el = document.createElement('section');
    const first = w('a', 1, { load: async () => 'old', render(b, d) { b.textContent = d; } });
    await mountWidget(el, first, {}, { contextKey: 'account:gym' });
    const refresh = w('a', 1, { load: async () => { throw new Error('offline'); }, render(b, d) { b.textContent = d; } });
    await mountWidget(el, refresh, {}, { contextKey: 'account:gym', skeleton: () => '<i class="sk"></i>' });
    expect(el.textContent).toContain('old');
    expect(el.querySelector('.sk')).toBeNull();
    expect(el.dataset.widgetState).toBe('stale');
    expect(el.dataset.widgetStale).toBe('true');
  });
  it('preserves mounted body nodes when a same-context refresh returns unchanged data', async () => {
    const el = document.createElement('section');
    const render = vi.fn((body, data) => {
      const button = document.createElement('button');
      button.textContent = data.label;
      body.append(button);
    });
    const widget = w('a', 1, { load: async () => ({ label: 'Current' }), render });
    await mountWidget(el, widget, {}, { contextKey: 'account:gym' });
    const button = el.querySelector('button');
    await mountWidget(el, widget, {}, { contextKey: 'account:gym' });
    expect(el.querySelector('button')).toBe(button);
    expect(render).toHaveBeenCalledTimes(1);
    expect(el.dataset.widgetState).toBe('ready');
  });
  it('repaints a same-context widget when its data changes', async () => {
    const el = document.createElement('section');
    let label = 'Before';
    const widget = w('a', 1, { load: async () => ({ label }), render(body, data) { body.textContent = data.label; } });
    await mountWidget(el, widget, {}, { contextKey: 'account:gym' });
    label = 'After';
    await mountWidget(el, widget, {}, { contextKey: 'account:gym' });
    expect(el.textContent).toContain('After');
  });
  it('repaints unchanged event data when its release-derived action crosses over', async () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement('section');
      const event = { id: 'event-1', releaseAt: 200 };
      const widget = w('a', 1, {
        load: async () => event,
        dataSignature(data) {
          return { id: data.id, action: Date.now() >= data.releaseAt ? 'Quick book' : 'Auto-Book' };
        },
        render(body, data) { body.textContent = Date.now() >= data.releaseAt ? `Quick book ${data.id}` : `Auto-Book ${data.id}`; },
      });
      vi.setSystemTime(100);
      await mountWidget(el, widget, {}, { contextKey: 'account:gym' });
      expect(el.textContent).toContain('Auto-Book');
      vi.setSystemTime(200);
      await mountWidget(el, widget, {}, { contextKey: 'account:gym' });
      expect(el.textContent).toContain('Quick book');
    } finally {
      vi.useRealTimers();
    }
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
