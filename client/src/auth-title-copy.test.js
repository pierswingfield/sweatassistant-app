import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY } from './copy.js';

// setAuthMode() sets the auth card's title/subtitle, then calls applyStaticCopy(), which rewrites
// every [data-copy-*] element. A data-copy attribute on these two nodes turned "Create Account"
// back into "Log in" on the signup screen.
describe('auth card heading', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it.each(['app-auth-title', 'app-auth-subtitle'])('%s is owned by setAuthMode, not static copy', (id) => {
    const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))[0];
    expect(tag).not.toMatch(/data-copy-/);
  });

  it('titles the signup screen "Create Account"', () => {
    expect(COPY.auth.createAccount).toBe('Create Account');
  });
});
