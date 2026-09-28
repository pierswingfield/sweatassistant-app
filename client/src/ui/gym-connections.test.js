import { describe, it, expect } from 'vitest';
import { createRenderGuard, reconcileKeyed, lastAuthLabel, connectionHealth } from './gym-connections.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');

function nav() {
  const el = document.createElement('nav');
  el.innerHTML = `<button data-s="general">General</button><button data-s="about">About</button>`;
  return el;
}
const opts = (container) => ({
  keyAttr: 'data-gym-nav',
  keyOf: (g) => g.gym_id,
  anchor: container.querySelector('[data-s="about"]'),
  create: (g) => { const b = document.createElement('button'); b.textContent = g.gym_name; return b; },
  update: (el, g) => { el.textContent = g.gym_name; },
});
const G = (id, name = id) => ({ gym_id: id, gym_name: name });
const keys = (c) => Array.from(c.querySelectorAll('[data-gym-nav]')).map((e) => e.getAttribute('data-gym-nav'));

describe('reconcileKeyed', () => {
  it('renders every item in order, before the anchor, leaving static children alone', () => {
    const c = nav();
    reconcileKeyed(c, [G('jab'), G('psycle')], opts(c));
    expect(Array.from(c.children).map((e) => e.textContent)).toEqual(['General', 'jab', 'psycle', 'About']);
  });

  it('is idempotent: rendering the same list again keeps the SAME elements', () => {
    const c = nav();
    reconcileKeyed(c, [G('jab'), G('psycle')], opts(c));
    const before = Array.from(c.querySelectorAll('[data-gym-nav]'));
    const { created, removed } = reconcileKeyed(c, [G('jab'), G('psycle')], opts(c));
    expect(created).toEqual([]);
    expect(removed).toEqual([]);
    Array.from(c.querySelectorAll('[data-gym-nav]')).forEach((el, i) => expect(el).toBe(before[i]));
  });

  it('runs update on a freshly created element too (create builds only the shell)', () => {
    const c = nav();
    reconcileKeyed(c, [G('jab', 'JAB')], {
      ...opts(c), create: () => document.createElement('button'),
    });
    expect(c.querySelector('[data-gym-nav="jab"]').textContent).toBe('JAB');
  });

  it('updates in place instead of rebuilding (keeps state such as .active)', () => {
    const c = nav();
    reconcileKeyed(c, [G('jab', 'JAB')], opts(c));
    c.querySelector('[data-gym-nav="jab"]').classList.add('active');
    reconcileKeyed(c, [G('jab', 'JAB Boxing Club')], opts(c));
    const el = c.querySelector('[data-gym-nav="jab"]');
    expect(el.classList.contains('active')).toBe(true);
    expect(el.textContent).toBe('JAB Boxing Club');
  });

  it('removes a gym that is no longer linked, and adds a new one', () => {
    const c = nav();
    reconcileKeyed(c, [G('jab'), G('psycle')], opts(c));
    const r = reconcileKeyed(c, [G('psycle'), G('third')], opts(c));
    expect(keys(c)).toEqual(['psycle', 'third']);
    expect(r.removed.map((x) => x.key)).toEqual(['jab']);
    expect(r.created).toEqual(['third']);
  });

  it('reorders to match the items', () => {
    const c = nav();
    reconcileKeyed(c, [G('a'), G('b'), G('c')], opts(c));
    reconcileKeyed(c, [G('c'), G('a'), G('b')], opts(c));
    expect(keys(c)).toEqual(['c', 'a', 'b']);
    expect(c.lastElementChild.textContent).toBe('About');
  });

  it('collapses a duplicate that is already in the DOM (the U1-7 symptom)', () => {
    const c = nav();
    reconcileKeyed(c, [G('psycle')], opts(c));
    const dupe = document.createElement('button');
    dupe.setAttribute('data-gym-nav', 'psycle');
    c.insertBefore(dupe, c.querySelector('[data-s="about"]'));
    expect(keys(c)).toEqual(['psycle', 'psycle']);
    reconcileKeyed(c, [G('psycle')], opts(c));
    expect(keys(c)).toEqual(['psycle']);
  });

  it('ignores duplicate keys in the items themselves', () => {
    const c = nav();
    reconcileKeyed(c, [G('x'), G('x')], opts(c));
    expect(keys(c)).toEqual(['x']);
  });
});

describe('createRenderGuard', () => {
  it('only the latest render is current', () => {
    const g = createRenderGuard();
    const a = g.begin();
    expect(g.isCurrent(a)).toBe(true);
    const b = g.begin();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
});

// The regression itself: the OLD algorithm (clear, then append per gym with an
// await in between) run twice concurrently duplicates a gym. The new one
// (keyed reconcile + a guard) cannot, whatever the interleaving.
describe('overlapping renders (U1-7)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  async function oldRender(c, linked) {
    c.querySelectorAll('[data-gym-nav]').forEach((e) => e.remove());
    for (const g of linked) {
      const b = document.createElement('button');
      b.setAttribute('data-gym-nav', g.gym_id);
      c.insertBefore(b, c.querySelector('[data-s="about"]'));
      await tick(); // each gym's settings section is fetched here
    }
  }

  async function newRender(c, guard, linked) {
    const token = guard.begin();
    reconcileKeyed(c, linked, opts(c));   // synchronous: the menu is complete at once
    for (const g of linked) {
      await tick();                        // per-gym pane content, sequential
      if (!guard.isCurrent(token)) return;
      void g;
    }
  }

  it('the old clear-then-append algorithm duplicates under overlap (documents the bug)', async () => {
    const c = nav();
    const linked = [G('jab'), G('psycle')];
    const a = oldRender(c, linked);        // A appends jab, then awaits its section
    const b = oldRender(c, linked);        // B clears A's jab, appends its own, awaits
    await Promise.all([a, b]);
    expect(keys(c).length).toBeGreaterThan(2);
  });

  it('the keyed render never duplicates, at any offset between two renders', async () => {
    for (let offset = 0; offset < 4; offset++) {
      const c = nav();
      const guard = createRenderGuard();
      const linked = [G('jab'), G('psycle')];
      const a = newRender(c, guard, linked);
      for (let i = 0; i < offset; i++) await tick();
      const b = newRender(c, guard, linked);
      await Promise.all([a, b]);
      expect(keys(c)).toEqual(['jab', 'psycle']);
    }
  });

  it('the full list is present synchronously, before any await', () => {
    const c = nav();
    const guard = createRenderGuard();
    void newRender(c, guard, [G('jab'), G('psycle')]);
    expect(keys(c)).toEqual(['jab', 'psycle']);
  });
});

describe('lastAuthLabel (U1-9 read side)', () => {
  it('says "Not recorded" only when there is no usable value', () => {
    expect(lastAuthLabel(null, NOW)).toBe('Not recorded');
    expect(lastAuthLabel('', NOW)).toBe('Not recorded');
    expect(lastAuthLabel('garbage', NOW)).toBe('Not recorded');
  });
  it('renders the server field (ISO string) as a relative date', () => {
    expect(lastAuthLabel('2026-09-28T09:00:00.000Z', NOW)).toMatch(/^Today · /);
    expect(lastAuthLabel('2026-09-27T09:00:00.000Z', NOW)).toMatch(/^Yesterday · /);
    expect(lastAuthLabel('2026-09-20T09:00:00.000Z', NOW)).toMatch(/^8 days ago · /);
    expect(lastAuthLabel('2026-06-01T09:00:00.000Z', NOW)).toBe('1 Jun 2026');
  });
});

describe('connectionHealth', () => {
  it('pairs a symbol with a word for each state', () => {
    expect(connectionHealth({ gym_enabled: 1, status: 'active' })).toMatchObject({ icon: '✓', label: 'Connected' });
    expect(connectionHealth({ gym_enabled: 1, status: 'needs_relogin' })).toMatchObject({ icon: '!', label: 'Reconnect needed' });
    expect(connectionHealth({ gym_enabled: 0, status: 'active' })).toMatchObject({ icon: '—', label: 'Not available yet' });
  });
});
