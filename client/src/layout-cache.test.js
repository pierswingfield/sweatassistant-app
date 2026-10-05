import { describe, it, expect, vi } from 'vitest';
import { createLayoutCache, layoutKey, FRESH_MS, MAX_AGE_MS } from './layout-cache.js';

const plan = (n) => ({ slots: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), x: i, y: 0, label: String(i + 1) })), objects: [] });

function setup(over = {}) {
  const db = new Map();
  let t = 1_000_000;
  const fetchLayout = vi.fn(async () => plan(3));
  const onChange = vi.fn();
  const cache = createLayoutCache({
    read: async (k) => db.get(k) ?? null,
    write: async (k, v) => { db.set(k, v); },
    fetchLayout: over.fetchLayout || fetchLayout, now: () => t, onChange,
  });
  return { cache, db, fetchLayout: over.fetchLayout || fetchLayout, onChange, advance: (ms) => { t += ms; } };
}

describe('layout cache', () => {
  it('second read is served from cache with no network', async () => {
    const { cache, fetchLayout } = setup();
    await cache.get('psycle-london', '1');
    const r = await cache.get('psycle-london', '1');
    expect(r.fromCache).toBe(true);
    expect(fetchLayout).toHaveBeenCalledTimes(1);
  });

  it('keys include the gym: the same studio id in two gyms never collides', async () => {
    const f = vi.fn(async (_s, gym) => (gym === 'jab-boxing' ? plan(2) : plan(5)));
    const { cache, db } = setup({ fetchLayout: f });
    const a = await cache.get('psycle-london', '1');
    const b = await cache.get('jab-boxing', '1');
    expect(a.slots).toHaveLength(5);
    expect(b.slots).toHaveLength(2);
    expect(layoutKey('psycle-london', '1')).not.toBe(layoutKey('jab-boxing', '1'));
    expect(db.size).toBe(2);
  });

  it('past the fresh window it serves cache and revalidates; changed hash notifies', async () => {
    const { cache, fetchLayout, advance, onChange } = setup();
    await cache.get('g', '1');
    fetchLayout.mockImplementation(async () => plan(4));
    advance(FRESH_MS + 1);
    const r = await cache.get('g', '1');
    expect(r.slots).toHaveLength(3); // stale served immediately
    await cache.revalidate('g', '1');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(cache.peek('g', '1').slots).toHaveLength(4);
  });

  it('revalidate failure keeps the cached plan and never throws', async () => {
    const { cache, fetchLayout, advance } = setup();
    await cache.get('g', '1');
    fetchLayout.mockRejectedValue(new TypeError('Load failed'));
    advance(FRESH_MS + 1);
    const r = await cache.get('g', '1');
    await cache.revalidate('g', '1');
    expect(r.slots).toHaveLength(3);
    expect(cache.peek('g', '1').slots).toHaveLength(3);
  });

  it('beyond max age it refetches, but falls back to the old plan if offline', async () => {
    const { cache, fetchLayout, advance } = setup();
    await cache.get('g', '1');
    advance(MAX_AGE_MS + 1);
    fetchLayout.mockRejectedValue(new TypeError('Load failed'));
    const r = await cache.get('g', '1');
    expect(r.slots).toHaveLength(3);
  });

  it('cold + offline throws; an empty (no map) answer never overwrites a known plan', async () => {
    const off = vi.fn(async () => { throw new TypeError('x'); });
    await expect(setup({ fetchLayout: off }).cache.get('g', '1')).rejects.toThrow();
    const { cache, fetchLayout, advance } = setup();
    await cache.get('g', '1');
    fetchLayout.mockResolvedValue({ slots: [], objects: [] });
    advance(FRESH_MS + 1);
    await cache.revalidate('g', '1');
    expect(cache.peek('g', '1').slots).toHaveLength(3);
  });

  it('strips per-class availability from remembered layouts', async () => {
    const { cache } = setup();
    await cache.remember('g', '9', [{ id: '1', x: 0, y: 0, label: '1', isAvailable: false }], []);
    expect(cache.peek('g', '9').slots[0]).not.toHaveProperty('isAvailable');
  });
});
