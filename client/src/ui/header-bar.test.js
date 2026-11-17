import { describe, it, expect } from 'vitest';
import { headerBarHtml, headerActionHtml, titleOffset } from './header-bar.js';

describe('header bar', () => {
  it('escapes back label, title and aria text', () => {
    const html = headerBarHtml({ back: { label: '<b>x</b>', aria: 'a"b', href: '/t' }, title: '<img onerror=1>' });
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<img');
    expect(html).toContain('app-hbar-title');
  });
  it('omits the heading when the title is empty', () => {
    const html = headerBarHtml({ back: { label: 'Teams', href: '/teams' }, actionsHtml: '<i></i>' });
    expect(html).not.toContain('app-hbar-title');
    expect(html).toContain('app-hbar-actions');
  });
  it('renders icon + text actions with a badge', () => {
    const html = headerActionHtml({ iconHtml: '<svg></svg>', label: 'Edit Team', attrs: 'data-manage', badge: 2 });
    expect(html).toContain('Edit Team');
    expect(html).toContain('app-hbar-badge');
  });
  it('centres on the bar when it fits, clamps right of a wide back label, truncates when tight', () => {
    expect(titleOffset({ barWidth: 390, titleWidth: 60, minX: 80, maxX: 300 }).left).toBe(165);
    expect(titleOffset({ barWidth: 390, titleWidth: 60, minX: 190, maxX: 380 }).left).toBe(190);
    expect(titleOffset({ barWidth: 390, titleWidth: 300, minX: 100, maxX: 250 })).toEqual({ left: 100, width: 150 });
  });
});
