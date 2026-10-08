// F-12: the timetable heart control, one markup for the desktop row and the mobile card.
// Pure (no DOM, no network) so the state contract is unit-tested.
const HEART_PATH = 'M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function heartButtonHtml({ isFavourite, eventId, label, pressedLabel, extraClass = '' }) {
  const text = esc(isFavourite ? pressedLabel : label);
  const cls = `app-timetable-heart ${isFavourite ? 'bookmarked' : 'unbookmarked'}${extraClass ? ` ${extraClass}` : ''}`;
  return `<button type="button" class="${cls}" data-event-id="${esc(eventId)}" aria-pressed="${isFavourite ? 'true' : 'false'}" aria-label="${text}" title="${text}"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="${isFavourite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${HEART_PATH}"/></svg></button>`;
}

/** Mobile card: the heart is an indicator of an existing favourite only. Un-favourited cards render nothing
 *  (favouriting happens from the kebab menu), so a card is never cluttered by an empty heart. */
export function mobileHeartHtml(opts) {
  return opts.isFavourite ? heartButtonHtml({ ...opts, extraClass: 'app-mobile-fav-indicator' }) : '';
}
