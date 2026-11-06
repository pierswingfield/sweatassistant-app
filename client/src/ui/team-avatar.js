// T10 Team avatar: ONE component for a Team's identity everywhere (list and Home cards, the
// Team page header, Settings > Privacy, the join page, the create flow). The app mascot sits
// in a frosted glass circle; the Team's emoji sits in a second, smaller glass circle that
// overlaps it at the lower right. A Team name is never concatenated with its emoji any more:
// the name renders alone and the emoji lives here.
//
// Pure markup. `mascotHtml` (teams-ui.js) is injected so this module stays importable in
// tests without the app shell; the emoji goes through the shared escaper.

import { escapeHtml } from '../escape-html.js';

/** Orb diameter, emoji badge diameter and mascot art size per named size (px). */
export const TEAM_AVATAR_SIZES = Object.freeze({
  sm: Object.freeze({ orb: 68, badge: 30 }),
  lg: Object.freeze({ orb: 112, badge: 44 }),
  hero: Object.freeze({ orb: 168, badge: 62 }),
});

/**
 * @param {object} opts
 *   emoji     the Team's emoji (null/'' = no badge)
 *   size      'sm' | 'lg' | 'hero'
 *   mascot    the server's mascot state (pose + ring), or null for the neutral art
 *   pose      neutral pose when there is no server mascot
 *   dim       hidden / not-a-member state
 *   alt       accessible name for the mascot image ('' = decorative)
 *   emptyBadge  draw an empty dashed badge where the emoji will go (create flow preview)
 * @param {{ mascotHtml: Function }} deps
 */
export function teamAvatarHtml({ emoji = null, size = 'sm', mascot = null, pose = 'resting', dim = false, alt = '', emptyBadge = false } = {}, { mascotHtml }) {
  const key = TEAM_AVATAR_SIZES[size] ? size : 'sm';
  const s = TEAM_AVATAR_SIZES[key];
  const art = Math.round(s.orb * 0.94);
  const e = typeof emoji === 'string' ? emoji.trim() : '';
  const badge = e
    ? `<span class="tm-tav-badge" aria-hidden="true"><span class="tm-tav-emoji">${escapeHtml(e)}</span></span>`
    : (emptyBadge ? '<span class="tm-tav-badge is-empty" aria-hidden="true"><span class="tm-tav-plus">+</span></span>' : '');
  return `<span class="tm-tav tm-tav-${key}${dim ? ' is-dim' : ''}${e ? ' has-emoji' : ''}" data-team-avatar>`
    + `<span class="tm-tav-orb">${mascotHtml({ size: art, pose, dim, alt, mascot })}</span>`
    + `${badge}</span>`;
}
