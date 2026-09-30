import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyStaticCopy, appCopy, COPY, formatCopyText } from './copy.js';
import { appConfig } from './config.js';

describe('application copy', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <p data-copy-html="about.taglineHtml"></p>
      <p data-copy-html="about.disclaimerHtml"></p>
      <span data-app-name>existing name marker</span>
      <p data-copy-text="onboarding.welcomeTitle"></p>
      <p data-copy-html="unknown.key">Keep this fallback</p>`;
  });

  it('substitutes the configured app name without replacing existing name markers', () => {
    applyStaticCopy(document, { appName: '<New & Name>' });

    const tagline = document.querySelector('[data-copy-html="about.taglineHtml"]');
    const disclaimer = document.querySelector('[data-copy-html="about.disclaimerHtml"]');
    expect(tagline.textContent).toContain('boutique fitness concierge');
    expect(tagline.textContent).toContain('<New & Name>');
    expect(tagline.querySelector('new')).toBeNull();
    expect(tagline.querySelector('[data-gym-name]')).toBeNull();
    expect(disclaimer.textContent).toContain('one-stop-shop for finding and booking classes');
    expect(disclaimer.textContent).toContain('Auto-Upgrade');
    expect(disclaimer.textContent).toContain('<New & Name>');
    expect(disclaimer.querySelector('[data-gym-name]')).toBeNull();
    expect(document.querySelector('[data-copy-html="unknown.key"]').textContent).toBe('Keep this fallback');
    expect(document.querySelector('[data-app-name]').textContent).toBe('existing name marker');
    expect(document.querySelector('[data-copy-text="onboarding.welcomeTitle"]').textContent).toBe('Welcome to your boutique fitness concierge!');
    expect(COPY.onboarding.welcomeTitle).toBe('Welcome to your boutique fitness concierge!');
  });
});

describe('copy catalog audit', () => {
  it('resolves every catalog reference and static shell binding', async () => {
    const fs = await import('node:fs');
    const sourceFiles = [
      'src/main.js',
      ...fs.readdirSync('src/ui').filter((file) => file.endsWith('.js') && !file.endsWith('.test.js')).map((file) => `src/ui/${file}`),
    ];
    for (const file of sourceFiles) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [, group, key] of source.matchAll(/COPY\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
        expect(COPY[group]?.[key], `${file}: COPY.${group}.${key}`).toBeTypeOf('string');
      }
    }

    const html = fs.readFileSync('index.html', 'utf8');
    for (const [, key] of html.matchAll(/data-copy-(?:text|html|placeholder|aria-label|title)="([^"]+)"/g)) {
      const value = key.split('.').reduce((copy, part) => copy?.[part], COPY);
      expect(value, `client/index.html: ${key}`).toBeTypeOf('string');
    }
  });

  it('keeps fixed toast wording in the copy catalog across client modules', async () => {
    const fs = await import('node:fs');
    const files = [
      'src/main.js',
      ...fs.readdirSync('src/ui').filter((file) => file.endsWith('.js') && !file.endsWith('.test.js')).map((file) => `src/ui/${file}`),
    ];
    const inlineStaticToast = /showToast\(\s*(?:'[^'\\n]{3,}'|"[^"\\n]{3,}"|`[^`$\\n]{3,}`)\s*,/;
    const inlineTextContent = /\.textContent\s*=\s*(['"])(?=[A-Za-z][^\n]{2,})[^'"\n]+\1/;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${file}: fixed toast copy`).not.toMatch(inlineStaticToast);
      expect(source, `${file}: fixed textContent copy`).not.toMatch(inlineTextContent);
    }
  });

  it('keeps onboarding, filter, overlap, refresh and spot setup copy in feature groups', () => {
    expect(COPY.onboarding.continueSetup).toBe('Get started');
    expect(COPY.filters.saveAsDefault).toBe('Save as default');
    expect(COPY.overlap.overlappingTitle).toBe('Overlapping class');
    expect(COPY.pullToRefresh.release).toBe('Release to refresh');
    expect(COPY.spotSelection.firstTimeSetup).toBe('First-time setup');
  });

  it('formats plain text without treating inserted values as HTML', () => {
    const value = formatCopyText('Studio: {studio}', { studio: '<img src=x onerror=alert(1)>' });
    const node = document.createElement('span');
    node.textContent = value;
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toContain('<img');
  });
});

describe('app name never renders as a literal placeholder', () => {
  it('appCopy resolves {appName} in every onboarding and auth string', () => {
    for (const group of ['onboarding', 'auth']) {
      for (const [key, value] of Object.entries(COPY[group])) {
        if (typeof value === 'string' && value.includes('{appName}')) {
          const out = appCopy(value);
          expect(out, `${group}.${key}`).not.toContain('{appName}');
          expect(out, `${group}.${key}`).toContain(appConfig.appName);
        }
      }
    }
  });

  it('onboarding source never renders an {appName} string without appCopy/formatCopyText', async () => {
    const fsm = await import('node:fs');
    const src = fsm.readFileSync('src/ui/onboarding.js', 'utf8');
    for (const [key, value] of Object.entries(COPY.onboarding)) {
      if (typeof value !== 'string' || !value.includes('{appName}')) continue;
      for (const m of src.matchAll(new RegExp('.*COPY\\.onboarding\\.' + key + '\\b.*', 'g'))) {
        expect(m[0], `onboarding.${key} must go through appCopy`).toMatch(/appCopy\(|formatCopyText\(/);
      }
    }
    expect(src).not.toMatch(/['"`>]Sweat Assistant/);
  });
});
