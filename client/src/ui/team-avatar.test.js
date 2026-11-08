// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { teamAvatarHtml, TEAM_AVATAR_SIZES } from './team-avatar.js';

const mascotHtml = (o) => `<span class="tm-mascot" data-size="${o.size}" data-alt="${o.alt}"${o.mascot ? ' data-server' : ''}></span>`;
const dom = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

describe('Team avatar (T10)', () => {
  it('puts the mascot in the orb and the emoji in an overlapping badge', () => {
    const el = dom(teamAvatarHtml({ emoji: '🏃', size: 'lg' }, { mascotHtml }));
    expect(el.classList.contains('tm-tav')).toBe(true);
    expect(el.classList.contains('tm-tav-lg')).toBe(true);
    expect(el.querySelector('.tm-tav-orb .tm-mascot')).not.toBeNull();
    expect(el.querySelector('.tm-tav-badge .tm-tav-emoji').textContent).toBe('🏃');
    expect(el.querySelector('.tm-tav-badge').getAttribute('aria-hidden')).toBe('true');
  });

  it('has three sizes, an unknown size falls back to small', () => {
    expect(Object.keys(TEAM_AVATAR_SIZES)).toEqual(['sm', 'lg', 'hero']);
    for (const s of ['sm', 'lg', 'hero']) {
      const el = dom(teamAvatarHtml({ emoji: '🔥', size: s }, { mascotHtml }));
      expect(el.classList.contains(`tm-tav-${s}`)).toBe(true);
      expect(Number(el.querySelector('.tm-mascot').dataset.size)).toBe(Math.round(TEAM_AVATAR_SIZES[s].orb * 0.94));
    }
    expect(dom(teamAvatarHtml({ size: 'huge' }, { mascotHtml })).classList.contains('tm-tav-sm')).toBe(true);
  });

  it('escapes the emoji (a Team emoji is user-supplied)', () => {
    const html = teamAvatarHtml({ emoji: '"><img src=x onerror=alert(1)>' }, { mascotHtml });
    expect(html).not.toContain('<img');
    expect(dom(html).querySelector('.tm-tav-emoji').textContent).toBe('"><img src=x onerror=alert(1)>');
  });

  it('no emoji: no badge, unless the create flow asks for the empty placeholder', () => {
    expect(dom(teamAvatarHtml({ emoji: null }, { mascotHtml })).querySelector('.tm-tav-badge')).toBeNull();
    expect(dom(teamAvatarHtml({ emoji: '  ' }, { mascotHtml })).querySelector('.tm-tav-badge')).toBeNull();
    const empty = dom(teamAvatarHtml({ emoji: '', emptyBadge: true }, { mascotHtml }));
    expect(empty.querySelector('.tm-tav-badge.is-empty')).not.toBeNull();
  });

  it('passes the server mascot, alt and dim state through', () => {
    const el = dom(teamAvatarHtml({ emoji: '🚲', dim: true, alt: 'Team mascot', mascot: { asset: '/characters/team-bed.webp' } }, { mascotHtml }));
    expect(el.classList.contains('is-dim')).toBe(true);
    expect(el.querySelector('.tm-mascot').dataset.alt).toBe('Team mascot');
    expect(el.querySelector('.tm-mascot').hasAttribute('data-server')).toBe(true);
  });
});
