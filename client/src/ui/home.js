// Home tab: a page of independent widgets (F-10-1).
// Framework lives in widget-registry.js; this file registers the widgets and paints the page.
import { api } from '../api.js';
import { COPY } from '../copy.js';
import { registerWidget, registry, mountWidget, isNoGymError } from './widget-registry.js';
import { renderCardSkeletons } from './loading-skeleton.js';
import { welcomeText } from './name-capture.js';
import { getTotalCredits, hasConfirmedAccess, isMetered } from './credit-allowance.js';
import { getGymShortName } from '../gym-context.js';
import { gymSquareChip } from './cards.js';
import { buildTimetableUrl } from '../url-state.js';
import { navigate } from '../router.js';
import { DateTime } from 'luxon';
import { groupBookingsByEvent, selectUpcoming } from './upcoming.js';
import { mountBookingCard } from './bookings.js';
import { formatInZone, zoneFor } from '../lib.js';

const goTo = (tabId) => (window.switchTab ? window.switchTab(tabId) : null);

// Eight widgets in the agreed order. W3 and W6-W8 are placeholders that later
// items (H-4 and H-6 ... H-9) fill in; W1, W2, W4 and W5 are real.
const PLACEHOLDERS = [
  ['favourites', 'favourites', 60],
  ['top-instructors', 'topInstructors', 70], ['stats', 'stats', 80],
];
for (const [id, key, order] of PLACEHOLDERS) {
  registerWidget({
    id, order, title: COPY.home[key],
    load: async () => null,
    isEmpty: () => true,
    emptyText: COPY.home.comingSoon,
    render() {},
  });
}

const gymIdOf = (gym) => String(gym?.gym_id || gym?.gymId || gym?.id || '');

/**
 * W2 routes are URL overlays, rather than saved timetable defaults. The final
 * f=all link is deliberately explicit so "All" means the merged timetable even
 * when this account has saved a narrower default filter set.
 */
export function getHomeBookLinks(gyms) {
  const seen = new Set();
  const links = [];
  for (const gym of Array.isArray(gyms) ? gyms : []) {
    const gymId = gymIdOf(gym);
    if (!gymId || seen.has(gymId)) continue;
    seen.add(gymId);
    links.push({
      gymId,
      name: getGymShortName(gymId) || gym.shortName || gym.name || gymId,
      href: buildTimetableUrl({ gym: [gymId] }),
    });
  }
  links.push({ gymId: null, name: COPY.home.bookAll, href: buildTimetableUrl({ explicit: true }) });
  return links;
}

function openTimetable(url) {
  if (!navigate(url)) return;
  // navigate() owns the history entry; switchTab paints that route without
  // replacing it or committing the URL overlay into the saved filter defaults.
  window.switchTab?.('class-timetable', { history: 'none' });
}

function addTimetableLinkHandler(anchor, url) {
  anchor.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openTimetable(url);
  });
}

registerWidget({
  id: 'book', order: 20, title: COPY.home.book,
  async load(ctx) { return getHomeBookLinks(ctx.gyms); },
  isEmpty: () => false,
  render(el, links) {
    const row = document.createElement('div');
    row.className = 'home-book-row';
    for (const link of links) {
      const anchor = document.createElement('a');
      anchor.className = link.gymId ? 'home-book-link home-book-gym' : 'home-book-link home-book-all';
      anchor.href = link.href;
      anchor.title = link.gymId ? `${COPY.home.book} · ${link.name}` : COPY.home.bookAll;
      anchor.setAttribute('aria-label', link.gymId ? `${COPY.home.book} · ${link.name}` : COPY.home.bookAll);
      if (link.gymId) anchor.innerHTML = gymSquareChip(link.gymId);
      else anchor.textContent = link.name;
      addTimetableLinkHandler(anchor, link.href);
      row.appendChild(anchor);
    }
    el.appendChild(row);
  },
});

/** Build useful per-gym allowances without treating an unknown answer as zero. */
export function getHomeCreditRows(gyms, { creditsByGym = {}, eligibilityByGym = {} } = {}) {
  if (!Array.isArray(gyms)) return [];
  return gyms.flatMap((gym) => {
    const gymId = String(gym.gym_id || gym.gymId || gym.id || '');
    if (!gymId) return [];
    const metered = isMetered(gymId);
    const hasCreditAnswer = Object.prototype.hasOwnProperty.call(creditsByGym, gymId);
    const hasEligibilityAnswer = Object.prototype.hasOwnProperty.call(eligibilityByGym, gymId);
    if (metered) {
      if (!hasCreditAnswer) return [];
      const count = getTotalCredits(gymId);
      return count > 0 ? [{ gymId, name: getGymShortName(gymId) || gym.shortName || gym.name || gymId, kind: 'credits', count }] : [];
    }
    if (!hasEligibilityAnswer || !hasConfirmedAccess(gymId)) return [];
    return [{ gymId, name: getGymShortName(gymId) || gym.shortName || gym.name || gymId, kind: 'membership' }];
  });
}

registerWidget({
  id: 'credits', order: 50, title: COPY.home.credits,
  async load(ctx) {
    const { cache } = await import('../main.js');
    const [creditsByGym, eligibilityByGym] = await Promise.all([
      api.getCreditsByGym(),
      api.getEligibilityByGym(),
    ]);
    cache.creditsByGym = { ...(cache.creditsByGym || {}), ...creditsByGym };
    cache.eligibilityByGym = { ...(cache.eligibilityByGym || {}), ...eligibilityByGym };
    return getHomeCreditRows(ctx.gyms, { creditsByGym, eligibilityByGym });
  },
  isEmpty: (rows) => Array.isArray(rows) && rows.length === 0,
  emptyText: COPY.home.noCredits,
  render(el, rows, ctx) {
    const list = document.createElement('div');
    list.className = 'home-credits-list';
    for (const row of rows) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'home-credits-row';
      const detail = row.kind === 'membership'
        ? COPY.credits.membershipKind
        : `${row.count} ${row.count === 1 ? COPY.credits.creditAvailableOne : COPY.credits.creditAvailableMany}`;
      item.innerHTML = '<span class="home-credits-gym"></span><span class="home-credits-detail"></span>';
      item.querySelector('.home-credits-gym').textContent = row.name;
      item.querySelector('.home-credits-detail').textContent = detail;
      item.addEventListener('click', () => ctx.navigate('buy-credits'));
      list.appendChild(item);
    }
    el.appendChild(list);
  },
});

registerWidget({
  id: 'welcome', order: 10, title: COPY.home.welcome,
  async load() { return api.getSettings(); },
  render(el, settings) {
    const greeting = document.createElement('p');
    greeting.className = 'home-welcome-greeting';
    greeting.textContent = welcomeText(settings?.firstName);
    el.appendChild(greeting);
  },
});

function upcomingChip(group) {
  const e = group.event;
  const zone = zoneFor(e, group.gymId);
  const when = formatInZone(e.startAt || e.start_at, zone).timeLabel;
  const photo = e.instructors?.[0]?.thumbUrl || e.instructors?.[0]?.imageUrl || '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'home-up-chip';
  btn.innerHTML = `<span class="home-up-gym">${gymSquareChip(group.gymId)}</span><span class="home-up-text"><span class="home-up-time"></span><span class="home-up-type"></span><span class="home-up-loc"></span></span>${photo ? '<img class="home-up-photo" alt="" loading="lazy">' : ''}`;
  btn.querySelector('.home-up-time').textContent = when;
  btn.querySelector('.home-up-type').textContent = e.discipline || e.name || '';
  btn.querySelector('.home-up-loc').textContent = e.locationName || e.studioName || '';
  if (photo) btn.querySelector('.home-up-photo').src = photo;
  btn.setAttribute('aria-expanded', 'false');
  return btn;
}

function viewAllBookings(ctx) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'home-view-all';
  button.textContent = COPY.home.viewAll;
  button.addEventListener('click', () => ctx.navigate('my-bookings'));
  return button;
}

registerWidget({
  id: 'upcoming', order: 30, title: COPY.home.upcoming,
  async load() {
    const [bookings, upgrades] = await Promise.all([api.getBookings({ silent: true }), api.getAutoUpgrades().catch(() => [])]);
    return { ...selectUpcoming(groupBookingsByEvent(bookings), DateTime.now()), upgrades: upgrades || [] };
  },
  isEmpty: (d) => d?.mode === 'card' && !d.next,
  emptyText: COPY.home.upcomingNone,
  renderEmpty(el, _d, ctx) {
    const message = document.createElement('p');
    message.className = 'home-widget-empty';
    message.textContent = COPY.home.upcomingNone;
    el.append(message, viewAllBookings(ctx));
  },
  render(el, d, ctx) {
    if (d.mode === 'card') {
      const holder = document.createElement('div'); holder.className = 'home-up-card';
      mountBookingCard(holder, d.next, d.upgrades);
      el.append(holder, viewAllBookings(ctx));
      return;
    }
    const strip = document.createElement('div'); strip.className = 'home-up-strip'; strip.setAttribute('aria-label', COPY.home.upcomingStripLabel);
    const detail = document.createElement('div'); detail.className = 'home-up-card';
    let openChip = null;
    for (const day of d.days) {
      const col = document.createElement('div'); col.className = 'home-up-day' + (day.groups.length ? ' has-classes' : '');
      const head = document.createElement('div'); head.className = 'home-up-day-head'; head.textContent = day.isToday ? COPY.home.upcomingToday : day.label;
      col.appendChild(head);
      for (const g of day.groups) {
        const chip = upcomingChip(g);
        chip.addEventListener('click', () => {
          detail.innerHTML = '';
          if (openChip === chip) { openChip.setAttribute('aria-expanded', 'false'); openChip = null; return; }
          openChip?.setAttribute('aria-expanded', 'false');
          chip.setAttribute('aria-expanded', 'true'); openChip = chip;
          mountBookingCard(detail, g, d.upgrades);
        });
        col.appendChild(chip);
      }
      strip.appendChild(col);
    }
    el.append(strip, detail, viewAllBookings(ctx));
  },
});

/** Pending = still in the queue (not executed), across every linked gym. */
export function countPendingAutoBooks(rows) {
  if (!Array.isArray(rows)) return null; // not loaded is not zero
  return rows.filter((r) => !r.executed_at).length;
}

registerWidget({
  id: 'auto-book-count', order: 40, title: COPY.home.autoBook,
  async load() { return countPendingAutoBooks(await api.getAutoBookings()); },
  render(el, count) {
    const n = count ?? 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-stat-tile';
    btn.innerHTML = `<span class="home-stat-number"></span><span class="home-stat-label"></span>`;
    btn.querySelector('.home-stat-number').textContent = String(n);
    btn.querySelector('.home-stat-label').textContent = n === 0 ? COPY.home.autoBookNone : (n === 1 ? COPY.home.autoBookOne : COPY.home.autoBookActive);
    btn.addEventListener('click', () => goTo('auto-book'));
    el.appendChild(btn);
  },
});

let host = null;
let renderRun = 0;

function widgetCopy() {
  return { empty: COPY.home.comingSoon, error: COPY.home.error, retry: COPY.home.retry, noGym: COPY.home.noGymWidget };
}

function renderConnectGym(root) {
  root.innerHTML = `<div class="home-connect-gym"><h4></h4><p></p><button type="button" class="home-connect-btn"></button></div>`;
  root.querySelector('h4').textContent = COPY.home.connectGymTitle;
  root.querySelector('p').textContent = COPY.home.connectGymBody;
  const b = root.querySelector('button');
  b.textContent = COPY.home.connectGymAction;
  b.addEventListener('click', () => goTo('settings'));
}

/** (Re)paint the whole page. Safe to call repeatedly; a newer call supersedes an older one. */
export async function renderHome() {
  host = host || document.getElementById('psycle-home-widgets');
  if (!host) return;
  const run = ++renderRun;
  let gyms = null;
  try { gyms = (await api.getMyGyms()).gyms || []; } catch (_) { /* widgets still try on their own */ }
  if (run !== renderRun) return;
  if (Array.isArray(gyms) && gyms.length === 0) { renderConnectGym(host); return; }
  const ctx = { gyms, navigate: goTo };
  const widgets = registry.list(ctx);
  host.innerHTML = '';
  const skeleton = () => renderCardSkeletons(1, COPY.home.loadingWidget);
  for (const w of widgets) {
    const el = document.createElement('section');
    el.className = 'home-widget';
    el.dataset.widgetId = w.id;
    host.appendChild(el);
    mountWidget(el, w, ctx, { skeleton, copy: widgetCopy() }); // independent; never awaited together
  }
}

export function initHome() { return renderHome(); }
export const refreshHome = renderHome;

export { isNoGymError };

// Re-render when the linked-gym set changes, and when the app returns to the foreground.
if (typeof window !== 'undefined') {
  const onHome = () => !!document.getElementById('psycle-panel-home') && document.getElementById('psycle-panel-home').style.display !== 'none';
  window.addEventListener('psycle:gyms-changed', () => { if (onHome()) renderHome(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && onHome()) renderHome(); });
}
