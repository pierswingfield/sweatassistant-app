import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadWordmarkSprites, spriteRefFor } from './gym-logo-sprite.js';
import { wordmarkElement } from './ui/cards.js';

describe('square mark in the shared SVG sprite', () => {
  it('keeps the nested sprite viewport at the asset origin so it cannot clip the mark', async () => {
    const src = '/gyms/barrys-mark.svg?v=2';
    const svg = readFileSync(resolve(process.cwd(), 'public/gyms/barrys-mark.svg'), 'utf8');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => svg }));
    try {
      loadWordmarkSprites([{ wordmark: { mark: { src } } }]);
      await vi.waitFor(() => expect(spriteRefFor(src)).not.toBeNull());
      const ref = spriteRefFor(src);
      expect(ref.viewBox).toBe('0 0 16 16');
      const symbol = document.getElementById(ref.id);
      expect(symbol.getAttribute('viewBox')).toBe(ref.viewBox);
      expect(symbol.querySelector('path')).not.toBeNull();
      const holder = document.createElement('div');
      holder.innerHTML = wordmarkElement('test-mark', src);
      expect(holder.querySelector('svg').getAttribute('viewBox')).toBe(ref.viewBox);
      expect(holder.querySelector('use').getAttribute('href')).toBe(`#${ref.id}`);
    } finally { globalThis.fetch = originalFetch; }
  });
});
