import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTemplatedAppName } from './config.js';

function docWith(html) {
  document.head.innerHTML = html;
  return document;
}

describe('templated app name', () => {
  it('ignores a rewritten <title> (Teams invite shell)', () => {
    const d = docWith('<title>You\'ve been invited to a Team on Dibs</title><meta name="application-name" content="Dibs">');
    expect(readTemplatedAppName(d)).toBe('Dibs');
  });
  it('is empty when the placeholder was not templated or the meta is absent', () => {
    expect(readTemplatedAppName(docWith('<meta name="application-name" content="__APP_NAME__">'))).toBe('');
    expect(readTemplatedAppName(docWith('<title>Anything</title>'))).toBe('');
  });
  it('index.html carries the templated meta', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html).toContain('<meta name="application-name" content="__APP_NAME__">');
  });
});
