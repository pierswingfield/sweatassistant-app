// Home tab: a page of independent widgets (F-10-1).
// Framework lives in widget-registry.js; this file registers the widgets and paints the page.
import { api } from '../api.js';
import { appConfig } from '../config.js';
import { COPY, formatCountLabel, formatCopyText } from '../copy.js';
import { registerWidget, registry, mountWidget, isNoGymError, orderIds } from './widget-registry.js';
import { renderCardSkeletons } from './loading-skeleton.js';
import { homeTeamsOrderFor, HOME_TEAMS_ORDER, HOME_ORDER_LAST } from './home-order.js';
import { greetingText } from './name-capture.js';
import { getTotalCredits, isMetered } from './credit-allowance.js';
import { canForGym, getGymShortName, getLinkedGyms, getAllLinkedGyms } from '../gym-context.js';
import { readCached } from '../cache.js';
import { cleanClassName, gymLogoPlate, gymSquareChip, icon, sparklesIcon } from './cards.js';
import { buildTimetableUrl } from '../url-state.js';
import { navigate } from '../router.js';
import { DateTime } from 'luxon';
import { groupBookingsByEvent, selectUpcoming } from './upcoming.js';
import { mountBookingCard } from './bookings.js';
import { countPendingAutoBooks } from './autobook-nav.js';
import { formatInZone, formatOpensIn, getClassReleaseTime, zoneFor } from '../lib.js';
import { instructorAvatar } from './tooltips.js';
import { safeImageUrl } from './safe-url.js';
import { indexFavourites, isFavouriteIn } from '../favourites.js';

const goTo = (tabId) => (window.switchTab ? window.switchTab(tabId) : null);

const gymIdOf = (gym) => String(gym?.gym_id || gym?.gymId || gym?.id || '');
const gymCacheKey = (path, gymId, extra = {}) => {
  const params = new URLSearchParams(extra);
  params.set('gymId', String(gymId));
  return `${path}?${params}`;
};
const uniqueGymIds = (gyms) => [...new Set((Array.isArray(gyms) ? gyms : []).map(gymIdOf).filter(Boolean))];
const homeContextKey = (gyms) => `${localStorage.getItem('appUserId') || ''}:${uniqueGymIds(gyms).sort().join(',')}`;
const isCurrentHomeContext = (ctx) => !!ctx?.contextKey && ctx.contextKey === homeContextKey(getLinkedGyms());

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
  if (!navigate(url, { state: { manualFilter: true } })) return;
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

function addBookingsDayLinkHandler(anchor, url) {
  anchor.addEventListener('click', (event) => {
    // Keep the real href for copy/open-in-new-tab and only take over an ordinary
    // primary click. The Bookings renderer reads the pushed day URL and focuses
    // its cached card before the refresh completes.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (!navigate(url)) return;
    window.switchTab?.('my-bookings', { history: 'none' });
  });
}

export function groupHomeGymLinks(links) {
  const items = Array.isArray(links) ? links : [];
  const perRow = items.length > 4 ? 3 : Math.max(items.length, 1);
  const rows = [];
  for (let offset = 0; offset < items.length; offset += perRow) rows.push(items.slice(offset, offset + perRow));
  return rows;
}

registerWidget({
  id: 'book', order: 40, title: COPY.home.findClass,
  async load(ctx) { return getHomeBookLinks(ctx.gyms); },
  isEmpty: () => false,
  render(el, links) {
    const row = document.createElement('div');
    row.className = 'home-book-row';
    const gymLinks = links.filter((link) => link.gymId);
    const gymRows = groupHomeGymLinks(gymLinks);
    for (const gymGroup of gymRows) {
      const gymRow = document.createElement('div');
      gymRow.className = `home-book-gym-row${gymLinks.length > 4 ? ' is-centered' : ''}`;
      if (gymLinks.length <= 4) gymRow.style.setProperty('--home-gym-count', String(gymLinks.length));
      for (const link of gymGroup) {
        const anchor = document.createElement('a');
        anchor.className = 'home-book-link home-book-gym';
        anchor.href = link.href;
        anchor.title = `${COPY.home.findClass} · ${link.name}`;
        anchor.setAttribute('aria-label', `${COPY.home.findClass} · ${link.name}`);
        anchor.innerHTML = gymLogoPlate(link.gymId);
        addTimetableLinkHandler(anchor, link.href);
        gymRow.appendChild(anchor);
      }
      row.appendChild(gymRow);
    }
    const allGymsLink = links.find((link) => !link.gymId);
    if (allGymsLink) {
      const anchor = document.createElement('a');
      anchor.className = 'home-book-link home-book-all';
      anchor.href = allGymsLink.href;
      anchor.title = COPY.home.findClass;
      anchor.setAttribute('aria-label', COPY.home.findClass);
      anchor.innerHTML = `${icon('calendar', 16)}<span class="home-book-all-label"></span><span class="home-book-all-arrow" aria-hidden="true">→</span>`;
      anchor.querySelector('.home-book-all-label').textContent = allGymsLink.name;
      addTimetableLinkHandler(anchor, allGymsLink.href);
      row.appendChild(anchor);
    }
    el.appendChild(row);
  },
});

/** Build one truthful, provider-published attendance row per linked gym. */
export function getHomeStats(gyms, byGym = {}) {
  const rows = [];
  let unavailable = 0;
  let unsupported = false;
  let failed = false;
  for (const gym of Array.isArray(gyms) ? gyms : []) {
    const gymId = gymIdOf(gym);
    if (!gymId) continue;
    const data = byGym[gymId] || {};
    if (data.attendanceUnsupported) { unavailable += 1; unsupported = true; continue; }
    const attendance = data.attendance;
    const rawTotal = attendance?.attendedTotal;
    const total = Number(rawTotal);
    if (rawTotal == null || rawTotal === '' || !Number.isInteger(total) || total < 0) {
      unavailable += 1;
      failed = true;
      continue;
    }
    rows.push({
      gymId,
      gymName: getGymShortName(gymId) || gym.shortName || gym.name || gymId,
      attendanceTotal: total,
      // A gym the member switched off is hidden outside Settings: it counts toward
      // the header total (from its stored class history) but gets no tile.
      ...(isDisabledLinkedGym(gym) ? { hidden: true } : {}),
    });
  }
  return { rows, partial: unavailable > 0, unsupported, failed };
}

/**
 * A linked gym that is switched off: by the member (Settings "Use this gym",
 * `account_enabled` 0), by the registry (`gym_enabled` 0) or by link status
 * 'disabled'. The server never contacts it; /api/attendance-totals answers from
 * its stored class history instead, whatever the gym's capabilities.
 */
export function isDisabledLinkedGym(gym) {
  if (!gym) return false;
  if (gym.account_enabled === 0 || gym.account_enabled === false) return true;
  const enabled = gym.gym_enabled ?? gym.gymEnabled ?? gym.enabled;
  return enabled === 0 || enabled === false || gym.status === 'disabled';
}

/** Whether the activity widget asks /api/attendance-totals for this gym. Disabled gyms always count. */
export function homeStatsWantsAttendance(gym) {
  const gymId = gymIdOf(gym);
  if (!gymId) return false;
  return isDisabledLinkedGym(gym) || canForGym('attendanceTotals', gymId);
}

/** Show an all-gym total only when every linked gym has valid attendance. */
export function getHomeActivityMeta({ rows, partial } = {}) {
  if (partial || !Array.isArray(rows) || rows.length === 0) return '';
  const total = rows.reduce((sum, row) => {
    const count = Number(row?.attendanceTotal);
    return Number.isSafeInteger(count) && count >= 0 ? sum + count : NaN;
  }, 0);
  return Number.isSafeInteger(total) && total >= 0
    ? formatCountLabel(total, 'class', 'classes')
    : '';
}

async function loadHomeStats(gyms) {
  const linked = (Array.isArray(gyms) ? gyms : []).filter((gym) => gymIdOf(gym));
  const settled = await Promise.allSettled(linked.map(async (gym) => {
    const gymId = gymIdOf(gym);
    // Capabilities are held by gym-context while public linked-gym rows stay
    // deliberately small. Resolve this known gym through that shared contract.
    // A disabled gym is always asked: the server serves its stored history count.
    if (!homeStatsWantsAttendance(gym)) return [gymId, { attendanceUnsupported: true }];
    const valid = (a) => a && a.attendedTotal != null && a.attendedTotal !== '' && Number.isInteger(Number(a.attendedTotal)) && Number(a.attendedTotal) >= 0;
    let attendance = null;
    try { attendance = await api.getAttendanceTotals(gymId, { loading: true }); } catch (_) { /* retried live below */ }
    // A failed or unusable answer (or a bad one served from the cache) gets one uncached retry, so a
    // transient failure cannot pin the widget to a partial result across app restarts.
    if (!valid(attendance)) attendance = await api.getAttendanceTotals(gymId, { ttlMs: 0, loading: true });
    return [gymId, { attendance }];
  }));
  const byGym = Object.fromEntries(settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value));
  return getHomeStats(gyms, byGym);
}

function openGymSettings(gymId) {
  goTo('settings');
  import('./settings.js').then((module) => module.openGymSettings(gymId)).catch((err) => {
    console.error('Open gym settings failed:', err);
  });
}

function attendanceTile(row, ctx) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'home-attendance-tile';
  item.setAttribute('aria-label', `Open ${row.gymName} settings: ${row.attendanceTotal} ${COPY.home.statsProviderAttended}`);
  item.innerHTML = '<span class="home-attendance-mark"></span><span class="home-attendance-stat"><strong class="home-attendance-number"></strong><span class="home-attendance-unit">classes</span></span>';
  item.querySelector('.home-attendance-mark').innerHTML = gymSquareChip(row.gymId);
  item.querySelector('.home-attendance-number').textContent = String(row.attendanceTotal);
  item.addEventListener('click', () => ctx.openGymSettings(row.gymId));
  return item;
}

// The activity total spans every linked gym, switched-off ones included (their
// stored history); every other widget sees only the enabled gyms in ctx.gyms.
const statsGyms = (ctx) => (Array.isArray(ctx.allGyms) ? ctx.allGyms : (Array.isArray(ctx.gyms) ? ctx.gyms : []));

registerWidget({
  id: 'stats', order: 70, title: COPY.home.stats,
  cacheKeys(ctx) {
    const gyms = statsGyms(ctx);
    const wanted = new Set(gyms.filter(homeStatsWantsAttendance).map(gymIdOf));
    return uniqueGymIds(gyms).filter((id) => wanted.has(id)).map((id) => gymCacheKey('/api/attendance-totals', id));
  },
  headerMeta: getHomeActivityMeta,
  async load(ctx) { return loadHomeStats(statsGyms(ctx)); },
  isEmpty: (data) => Array.isArray(data?.rows) && data.rows.length === 0 && !data.unsupported && !data.failed,
  emptyText: COPY.home.statsNone,
  render(el, data, ctx) {
    const grid = document.createElement('div');
    grid.className = 'home-attendance-grid';
    data.rows.filter((row) => !row.hidden).forEach((row) => grid.appendChild(attendanceTile(row, ctx)));
    el.appendChild(grid);
    for (const text of [data.unsupported && COPY.home.statsUnsupported, data.failed && COPY.home.statsPartial].filter(Boolean)) {
      const note = document.createElement('p');
      note.className = 'home-stats-partial';
      note.textContent = text;
      el.appendChild(note);
    }
  },
});

function guestCreditBalance(credits) {
  if (!Array.isArray(credits)) return { known: false, count: null };
  const guestRows = credits.filter((credit) => credit && credit.isGuestOnly === true);
  if (!guestRows.length) return { known: false, count: null };
  const counts = guestRows.map((credit) => Number(credit.count));
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) return { known: false, count: null };
  return { known: true, count: counts.reduce((sum, count) => sum + count, 0) };
}

/** Build one Home allowance row per linked gym while keeping missing answers unknown. */
export function getHomeCreditRows(gyms, { creditsByGym = {}, eligibilityByGym = {}, membershipByGym = {} } = {}) {
  if (!Array.isArray(gyms)) return [];
  return gyms.flatMap((gym) => {
    const gymId = String(gym.gym_id || gym.gymId || gym.id || '');
    if (!gymId) return [];
    const metered = isMetered(gymId);
    const hasCreditAnswer = Object.prototype.hasOwnProperty.call(creditsByGym, gymId);
    if (metered) {
      // Keep member credits on the existing shared arithmetic path. Guest-only
      // rows are deliberately a separate balance and never increase `count`.
      const hasCreditInventory = hasCreditAnswer && Array.isArray(creditsByGym[gymId]);
      const count = hasCreditInventory ? getTotalCredits(gymId) : null;
      const guest = hasCreditInventory ? guestCreditBalance(creditsByGym[gymId]) : { known: false, count: null };
      return [{
        gymId,
        name: getGymShortName(gymId) || gym.shortName || gym.name || gymId,
        kind: 'credits',
        count,
        memberCredits: count,
        guestCredits: guest.known ? guest.count : null,
        balanceKnown: hasCreditInventory,
      }];
    }
    const eligibility = Object.prototype.hasOwnProperty.call(eligibilityByGym, gymId)
      ? eligibilityByGym[gymId]
      : null;
    const membershipStatus = eligibility?.canBook === true
      ? 'active'
      : eligibility?.canBook === false ? 'inactive' : 'unknown';
    const membership = Object.prototype.hasOwnProperty.call(membershipByGym, gymId)
      ? membershipByGym[gymId]
      : null;
    const rawGuestPasses = membership?.guestPassesRemaining;
    const guestPasses = membershipStatus === 'active' && rawGuestPasses != null && rawGuestPasses !== ''
      && Number.isFinite(Number(rawGuestPasses)) && Number(rawGuestPasses) >= 0
      ? Number(rawGuestPasses)
      : null;
    return [{
      gymId,
      name: getGymShortName(gymId) || gym.shortName || gym.name || gymId,
      kind: 'membership',
      membershipStatus,
      guestPasses,
    }];
  });
}

registerWidget({
  id: 'credits', order: 60, title: COPY.home.credits,
  cacheKeys(ctx) {
    return uniqueGymIds(ctx.gyms).flatMap((id) => [gymCacheKey('/api/credits', id), gymCacheKey('/api/eligibility', id), gymCacheKey('/api/membership', id)]);
  },
  headerMeta: (rows) => Array.isArray(rows) && rows.length ? formatCountLabel(rows.length, 'gym') : '',
  async load(ctx) {
    const { cache } = await import('../main.js');
    const [creditsByGym, eligibilityByGym, membershipByGym] = await Promise.all([
      api.getCreditsByGym({ gyms: ctx.gyms, loading: true }),
      api.getEligibilityByGym({ gyms: ctx.gyms, loading: true }),
      api.getMembershipsByGym({ gyms: ctx.gyms, loading: true }),
    ]);
    if (isCurrentHomeContext(ctx)) {
      cache.creditsByGym = { ...(cache.creditsByGym || {}), ...creditsByGym };
      cache.eligibilityByGym = { ...(cache.eligibilityByGym || {}), ...eligibilityByGym };
    }
    return getHomeCreditRows(ctx.gyms, { creditsByGym, eligibilityByGym, membershipByGym });
  },
  isEmpty: (rows) => Array.isArray(rows) && rows.length === 0,
  emptyText: COPY.home.noCredits,
  render(el, rows, ctx) {
    const list = document.createElement('div');
    list.className = 'home-credits-grid';
    for (const row of rows) {
      const item = document.createElement('button');
      item.type = 'button';
      const membership = row.kind === 'membership';
      item.className = `home-credits-tile${membership ? ` is-membership is-${row.membershipStatus}` : row.balanceKnown ? '' : ' is-unknown'}`;
      const kind = membership ? '' : 'Class credits';
      const balance = membership
        ? row.membershipStatus === 'active' ? 'Membership' : row.membershipStatus === 'inactive' ? COPY.timetable.noMembership : 'Unavailable'
        : row.balanceKnown ? String(row.memberCredits) : 'Unavailable';
      const guest = membership
        ? (row.guestPasses == null ? '' : `Guest passes: ${row.guestPasses}`)
        : (row.guestCredits == null ? '' : `Guest credits: ${row.guestCredits}`);
      item.setAttribute('aria-label', `${row.name}: ${balance}${guest ? `, ${guest}` : ''}`);
      item.innerHTML = '<span class="home-credits-mark"></span><span class="home-credits-value"><strong class="home-credits-balance"></strong><span class="home-credits-kind"></span></span><span class="home-credits-detail"></span>';
      item.querySelector('.home-credits-mark').innerHTML = gymSquareChip(row.gymId);
      item.querySelector('.home-credits-kind').textContent = kind;
      item.querySelector('.home-credits-balance').textContent = balance;
      const detail = item.querySelector('.home-credits-detail');
      detail.textContent = guest;
      if (membership) item.querySelector('.home-credits-value').appendChild(detail);
      item.addEventListener('click', () => ctx.openGymSettings(row.gymId));
      list.appendChild(item);
    }
    el.appendChild(list);
  },
});

function upcomingChip(group) {
  const e = group.event;
  const zone = zoneFor(e, group.gymId);
  const when = formatInZone(e.startAt || e.start_at, zone).timeLabel;
  const photo = safeImageUrl(e.instructors?.[0]?.thumbUrl || e.instructors?.[0]?.imageUrl || '');
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

function viewAllBookingsLabel(count) {
  if (!Number.isFinite(Number(count)) || Number(count) === 0) return COPY.home.viewAll;
  const noun = Number(count) === 1 ? 'booking' : 'bookings';
  return `View all ${count} ${noun}`;
}

function viewAllBookings(ctx, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'home-view-all';
  button.textContent = viewAllBookingsLabel(count);
  button.addEventListener('click', () => ctx.navigate('my-bookings'));
  return button;
}

function updateViewAllBookings(actionSlot, count) {
  const button = actionSlot.querySelector('.home-view-all');
  if (!button) return;
  const label = viewAllBookingsLabel(count);
  if (button.textContent !== label) button.textContent = label;
}

function clearHomeUpcomingStrip() {
  document.querySelectorAll('#app-panel-home > .home-up-strip').forEach((strip) => strip.remove());
}

function mountHomeBookingCard(container, group, ctx) {
  mountBookingCard(container, group, []);
  const card = container.querySelector('.ab-card');
  if (!card) return;
  card.classList.add('home-booking-card');
  card.querySelector('.ab-card-footer')?.remove();
  card.querySelector('.ab-card-rail')?.remove();
  const event = group.event || {};
  const label = [event.name || event.discipline || COPY.autoBook.class, event.startAt || event.start_at].filter(Boolean).join(' · ');
  card.setAttribute('role', 'link');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', label);
  const open = () => ctx.navigate('my-bookings');
  card.addEventListener('click', open);
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
}

function mountHomeBookingCards(container, groups, ctx) {
  const list = document.createElement('div');
  list.className = 'home-booking-cards';
  groups.forEach((group) => {
    const holder = document.createElement('div');
    mountHomeBookingCard(holder, group, ctx);
    list.appendChild(holder);
  });
  container.appendChild(list);
}

function renderBookingDay(day) {
  const target = day.groups.length ? document.createElement('a') : document.createElement('div');
  target.className = `home-up-day${day.groups.length ? ' has-classes' : ''}${day.isToday ? ' is-today' : ''}`;
  if (day.groups.length) {
    target.href = day.href;
    target.setAttribute('aria-label', `${day.label}: ${day.groups.length} ${day.groups.length === 1 ? 'class' : 'classes'}`);
    addBookingsDayLinkHandler(target, day.href);
  }
  const head = document.createElement('span');
  head.className = 'home-up-day-head';
  head.textContent = day.isToday ? COPY.home.upcomingToday : day.label;
  target.appendChild(head);
  const marks = document.createElement('span');
  marks.className = 'home-up-day-marks';
  day.groups.forEach((group) => {
    const mark = document.createElement('span');
    mark.className = 'home-up-day-mark';
    mark.innerHTML = gymSquareChip(group.gymId);
    mark.setAttribute('aria-hidden', 'true');
    marks.appendChild(mark);
  });
  target.appendChild(marks);
  return target;
}

function paintHomeGreeting(settings) {
  const header = document.querySelector('#app-panel-home > .app-tab-header');
  if (!header) return;
  const firstName = String(settings?.firstName || '').trim().split(/\s+/)[0] || '';
  const greetingLine = greetingText(firstName);
  const existing = header.querySelector('.home-greeting-lead');
  if (existing) {
    // Foreground/cache refreshes routinely revisit Home. Updating the three
    // text nodes keeps the header's focusable refresh control and DOM identity.
    existing.querySelector('.home-greeting-avatar').alt = appConfig.appName || '';
    existing.querySelector('.home-greeting-name').textContent = greetingLine;
    header.classList.add('home-page-header');
    return;
  }
  const greeting = document.createElement('div');
  greeting.className = 'home-greeting-lead';
  // The app's mascot (not the member's initial). 180px-tall cut-out for a 32px slot stays crisp at 3x.
  const avatar = document.createElement('img');
  avatar.className = 'home-greeting-avatar';
  avatar.src = '/characters/dumbbell.png';
  avatar.width = 45; avatar.height = 32;
  avatar.alt = appConfig.appName || '';
  avatar.decoding = 'async';
  const copy = document.createElement('span');
  copy.className = 'home-greeting-copy';
  const name = document.createElement('h1');
  name.className = 'home-greeting-name';
  name.textContent = greetingLine;
  copy.append(name);
  greeting.append(avatar, copy);
  const refresh = header.querySelector('[data-refresh-tab="home"]');
  header.replaceChildren(greeting);
  if (refresh) header.appendChild(refresh);
  header.classList.add('home-page-header');
}

/** Count waitlisted classes that have not started yet. Unknown (null) is not zero. */
export function countUpcomingWaitlists(waitlists, now = Date.now()) {
  if (!Array.isArray(waitlists)) return null;
  return waitlists.filter((w) => {
    const t = Date.parse(w?.event?.startAt || w?.event?.start_at || w?.startAt || w?.start_at || '');
    return !Number.isFinite(t) || t >= now;
  }).length;
}

/** 'hidden' = no booked and no waitlisted classes; 'waitlist-only' = no booked but waitlisted. */
export function homeUpcomingMode(bookedCount, waitlistCount) {
  const booked = Number(bookedCount) || 0;
  const waitlisted = Number(waitlistCount) || 0;
  if (!booked && !waitlisted) return 'hidden';
  return booked ? 'booked' : 'waitlist-only';
}

/** '+ 2 waitlisted classes' under booked cards; '1 waitlisted class' when it is the only content. */
export function waitlistLineText(count, { withPlus = true } = {}) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  const text = formatCopyText(n === 1 ? COPY.home.waitlistedOne : COPY.home.waitlistedMany, { count: n });
  return withPlus ? `+ ${text}` : text;
}

function renderWaitlistLine(el, count, withPlus, ctx) {
  const text = waitlistLineText(count, { withPlus });
  if (!text) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'home-waitlist-line';
  btn.textContent = text;
  btn.addEventListener('click', () => ctx.navigate('my-bookings'));
  el.appendChild(btn);
}

registerWidget({
  id: 'upcoming', order: 20,
  title: () => COPY.home.upcoming,
  headerAction: (ctx) => viewAllBookings(ctx),
  updateHeaderAction: (slot, _ctx, data) => updateViewAllBookings(slot, data?.bookedCount),
  cacheKeys(ctx) { return [...uniqueGymIds(ctx.gyms).map((id) => gymCacheKey('/api/bookings', id)), ...uniqueGymIds(ctx.gyms).map((id) => gymCacheKey('/api/waitlists', id)), '/api/auto-upgrade', '/api/auto-book']; },
  async load(ctx) {
    const [bookings, waitlists, upgrades, queue] = await Promise.all([
      api.getBookings({ cacheTtlMs: 120000, gyms: ctx.gyms }),
      api.getWaitlists({ cacheTtlMs: 120000, gyms: ctx.gyms, silent: true }).catch(() => null),
      api.getAutoUpgrades({ gymIds: uniqueGymIds(ctx.gyms), loading: true }).catch(() => []),
      api.getAutoBookings({ gymIds: uniqueGymIds(ctx.gyms), loading: true }).catch(() => null),
    ]);
    const now = DateTime.now();
    const groups = groupBookingsByEvent(bookings);
    const bookedCount = groups.filter((group) => Date.parse(group.event.startAt || group.event.start_at) >= now.toMillis()).length;
    return { ...selectUpcoming(groups, now), bookedCount, waitlistCount: countUpcomingWaitlists(waitlists, now.toMillis()), upgrades: upgrades || [], queueCount: countPendingAutoBooks(queue) };
  },
  isHidden: (d) => homeUpcomingMode(d?.bookedCount, d?.waitlistCount) === 'hidden',
  onHide: () => clearHomeUpcomingStrip(),
  render(el, d, ctx) {
    mountHomeBookingCards(el, d.cards?.length ? d.cards : (d.next ? [d.next] : []), ctx);
    if (d.mode === 'strip') {
      clearHomeUpcomingStrip();
      const strip = document.createElement('div');
      strip.className = 'home-up-strip';
      strip.setAttribute('aria-label', COPY.home.upcomingStripLabel);
      d.days.forEach((day) => strip.appendChild(renderBookingDay(day)));
      const header = document.querySelector('#app-panel-home > .app-tab-header.home-page-header');
      if (header) header.insertAdjacentElement('afterend', strip);
      else strip.remove();
    } else {
      clearHomeUpcomingStrip();
    }
    renderWaitlistLine(el, d.waitlistCount, d.bookedCount > 0, ctx);
    renderAutoBookQueue(el, d.queueCount);
  },
});

// T-5 "Your Teams today" (PLAN-teams.md §5.3): the top two Teams' today lines, from the
// same list projection as the Teams tab (GET /api/teams). Modules load lazily so Home's
// import graph (and its tests) stay as they were. Empty = no Teams: one line + Create.
async function teamsWidgetDeps() {
  const [ui, model, api_, cards] = await Promise.all([
    import('./teams-ui.js'), import('./home-teams.js'), import('../teams-api.js'), import('./cards.js'),
  ]);
  return {
    ui: { T: ui.T, fmt: ui.fmt, mascotHtml: ui.mascotHtml, teamTitleText: ui.teamTitleText, segmentsHtml: ui.segmentsHtml, whenOf: ui.whenOf, escapeHtml: cards.escapeHtml },
    model, teamsApi: api_.teamsApi,
  };
}
const openTeam = (teamId) => (window.switchTab ? window.switchTab('teams', { teams: teamId ? { view: 'team', teamId } : { view: 'list' } }) : null);

// Teams widget placement (owner, 2026-11-06): in a Team it keeps order 30 (after Upcoming);
// in no Team its "Create a Team" card goes BELOW every other widget (homeTeamsOrder). The
// last answer is remembered so a no-Team member's skeleton does not appear at 30 first.
let teamsEmptyHint = null;
const TEAMS_EMPTY_HINT_KEY = 'appHomeTeamsEmpty';
function readTeamsEmptyHint() {
  if (teamsEmptyHint !== null) return teamsEmptyHint;
  try { teamsEmptyHint = localStorage.getItem(`${TEAMS_EMPTY_HINT_KEY}:${localStorage.getItem('appUserId') || ''}`) === '1'; } catch (_) { teamsEmptyHint = false; }
  return teamsEmptyHint;
}
function writeTeamsEmptyHint(empty) {
  teamsEmptyHint = !!empty;
  try { localStorage.setItem(`${TEAMS_EMPTY_HINT_KEY}:${localStorage.getItem('appUserId') || ''}`, empty ? '1' : '0'); } catch (_) { /* per-device convenience only */ }
}

registerWidget({
  id: 'teams', order: HOME_TEAMS_ORDER,
  orderFor: (outcome) => {
    if (outcome === 'empty') writeTeamsEmptyHint(true);
    else if (outcome === 'ready') writeTeamsEmptyHint(false);
    return homeTeamsOrderFor(outcome, readTeamsEmptyHint());
  },
  title: () => COPY.teams.homeTitle,
  async load() {
    const deps = await teamsWidgetDeps();
    const res = await deps.teamsApi.list();
    const rows = deps.model.homeTeamsModel(res && res.teams, { when: deps.ui.whenOf, copy: deps.ui.T });
    return { rows, deps };
  },
  dataSignature: (d) => (d ? d.rows : null),
  isEmpty: (d) => !d || !d.rows.length,
  renderEmpty(el, d) {
    if (!d || !d.deps) return;
    d.deps.model.renderHomeTeamsEmpty(el, {
      ui: d.deps.ui,
      onCreate: () => { openTeam(null); import('./teams.js').then((m) => m.openCreateFlow()).catch(() => {}); },
    });
  },
  render(el, d) {
    d.deps.model.renderHomeTeams(el, d.rows, { ui: d.deps.ui, onOpen: openTeam });
  },
});

export { countPendingAutoBooks };

function renderAutoBookQueue(el, count) {
  if (count === 0) return;
  const section = document.createElement('div');
  section.className = 'home-upcoming-queue';
  if (count == null) {
    const unavailable = document.createElement('p');
    unavailable.className = 'home-widget-empty';
    unavailable.textContent = COPY.home.autoBookUnavailable;
    section.appendChild(unavailable);
  } else {
    const n = count;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-autobook-row';
    btn.innerHTML = `<span class="home-autobook-icon" aria-hidden="true">${sparklesIcon(16)}</span><strong class="home-autobook-title"></strong><span class="home-autobook-status"><strong class="home-autobook-count"></strong></span>`;
    btn.querySelector('.home-autobook-title').textContent = COPY.home.autoBookQueue;
    btn.querySelector('.home-autobook-count').textContent = n === 0 ? '0' : `${n} Pending`;
    btn.setAttribute('aria-label', `${COPY.home.autoBookQueue}: ${btn.querySelector('.home-autobook-count').textContent}`);
    btn.addEventListener('click', () => goTo('auto-book'));
    section.appendChild(btn);
  }
  el.appendChild(section);
}

/**
 * Favourite classes in the next seven 24-hour days. A missing per-gym index
 * remains loading, never an empty list: ids from two providers can collide,
 * so a loaded gym must not stand in for another.
 */
export function getHomeFavouriteRows(gyms, {
  favouritesByGym = {}, events = [], now = new Date(), scheduleLoading = false,
} = {}) {
  const gymIds = [...new Set((Array.isArray(gyms) ? gyms : []).map(gymIdOf).filter(Boolean))];
  const start = now.getTime();
  const end = start + (7 * 24 * 60 * 60 * 1000);
  const loaded = new Set(gymIds.filter((gymId) => !!favouritesByGym[gymId]));
  const rows = (Array.isArray(events) ? events : [])
    .filter((event) => {
      const gymId = String(event?.gymId || '');
      const time = Date.parse(event?.startAt || '');
      return loaded.has(gymId) && Number.isFinite(time) && time >= start && time < end
        && isFavouriteIn(favouritesByGym[gymId], event);
    })
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  if (rows.length) return { state: 'list', rows };
  if (scheduleLoading || loaded.size !== gymIds.length) return { state: 'loading', rows: [] };
  return { state: 'empty', rows: [] };
}

async function loadHomeFavourites(ctx) {
  const { gyms } = ctx;
  const [{ cache }, timetable] = await Promise.all([
    import('../main.js'), import('./timetable.js'),
  ]);
  const gymIds = [...new Set((Array.isArray(gyms) ? gyms : []).map(gymIdOf).filter(Boolean))];
  const settled = await Promise.allSettled(gymIds.map((gymId) => api.getFavourites(gymId, { loading: true })));
  const favouritesByGym = { ...(cache.favouritesByGym || {}) };
  const decisionByGym = { ...favouritesByGym };
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && Array.isArray(result.value?.favourites)) {
      favouritesByGym[gymIds[index]] = indexFavourites(result.value.favourites);
      decisionByGym[gymIds[index]] = favouritesByGym[gymIds[index]];
    } else if (!decisionByGym[gymIds[index]]) {
      // One gym failing must not hold the others back: it counts as "no favourites" for this render only.
      decisionByGym[gymIds[index]] = indexFavourites([]);
    }
  });
  if (isCurrentHomeContext(ctx)) cache.favouritesByGym = favouritesByGym;
  const events = timetable.getLoadedEvents();
  if (!events.length) timetable.ensureScheduleLoaded();
  return {
    ...getHomeFavouriteRows(gyms, {
      favouritesByGym: decisionByGym,
      events,
      scheduleLoading: timetable.isScheduleLoading(),
    }),
    primaryActionForEvent: timetable.primaryActionForEvent,
    actionGlyph: timetable.actionGlyph,
  };
}

export function getHomeFavouriteStatus(event, now = DateTime.now(), viewingZone) {
  const release = getClassReleaseTime(event);
  if (release?.isValid && release.toMillis() > now.toMillis()) {
    return { kind: 'release', label: formatOpensIn(release.toMillis() - now.toMillis(), { html: false }) };
  }
  if (event?.isFull) {
    return event.waitlistAvailable === false
      ? { kind: 'full', label: 'Full' }
      : { kind: 'waitlist', label: 'Full · waitlist available' };
  }
  if (Number.isFinite(Number(event?.availableCount))) {
    const count = Number(event.availableCount);
    return { kind: count === 0 ? 'full' : 'open', label: `${count} ${count === 1 ? 'spot' : 'spots'} left` };
  }
  if (event?.alwaysBookable || release?.isValid) return { kind: 'open', label: 'Open' };
  return { kind: 'unknown', label: 'Availability not published' };
}

/**
 * `options` (T-3 Teams "Classes together" reuses this card, PLAN-teams.md §5.3):
 *   extra   an element placed left of the CTA (the teammates' avatars)
 *   status  { kind, label } overriding the availability line (e.g. a class not in the loaded timetable)
 */
export function renderHomeFavouriteCard(event, primaryActionForEvent, actionGlyph = null, options = {}) {
  const zone = zoneFor(event);
  const dt = DateTime.fromISO(String(event.startAt), { setZone: true }).setZone(zone);
  const formatted = formatInZone(event.startAt, zone);
  const instructor = event.instructors?.[0] || {};
  const instructorName = String(instructor.name || '').trim();
  const status = options.status || getHomeFavouriteStatus(event);
  const card = document.createElement('article');
  card.className = 'home-favourite-card';
  const media = document.createElement('div');
  media.className = 'home-favourite-media';
  const photo = instructor.thumbUrl || instructor.imageUrl || null;
  const avatar = instructorAvatar(instructorName, event.gymId, photo, { size: 128, cls: 'home-favourite-avatar' });
  if (avatar) {
    const holder = document.createElement('span');
    holder.innerHTML = avatar;
    media.appendChild(holder.firstElementChild);
  } else {
    const initial = document.createElement('span');
    initial.className = 'home-favourite-initial';
    initial.textContent = instructorName.charAt(0).toUpperCase() || '?';
    media.appendChild(initial);
  }
  const instructorLabel = document.createElement('span');
  instructorLabel.className = 'home-favourite-instructor';
  instructorLabel.textContent = instructorName || COPY.timetable.instructor;
  instructorLabel.title = instructorLabel.textContent;
  media.appendChild(instructorLabel);

  const body = document.createElement('div');
  body.className = 'home-favourite-body';
  const meta = document.createElement('div');
  meta.className = 'home-favourite-meta';
  const gym = document.createElement('span');
  gym.className = 'home-favourite-gym';
  gym.innerHTML = gymSquareChip(event.gymId);
  const when = document.createElement('div');
  when.className = 'home-favourite-when';
  when.textContent = `${formatted.date || (dt.isValid ? dt.toFormat('ccc d LLL') : '')} · ${formatted.timeLabel}`.trim();
  meta.append(gym, when);
  const className = document.createElement('div');
  className.className = 'home-favourite-class';
  className.textContent = cleanClassName(event.name || '', event.discipline || '') || event.name || COPY.common.classFallback;
  className.title = className.textContent;
  const availability = document.createElement('p');
  availability.className = `home-favourite-status is-${status.kind}`;
  availability.textContent = status.label;
  body.append(meta, className, availability);

  const action = primaryActionForEvent(event);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'home-favourite-cta';
  button.classList.add(`variant-${action.variant}`);
  const glyph = typeof actionGlyph === 'function' ? actionGlyph(action.label) : '';
  if (glyph) {
    const icon = document.createElement('span');
    icon.className = 'app-seg-ico';
    icon.setAttribute('aria-hidden', 'true');
    if (glyph.startsWith('<')) icon.innerHTML = glyph;
    else icon.textContent = glyph;
    button.append(icon);
  }
  button.append(document.createTextNode(action.label));
  if (action.title) { button.title = action.title; button.setAttribute('aria-label', action.title); }
  if (action.disabled) button.disabled = true;
  else if (action.run) button.addEventListener('click', () => action.run(button));
  if (options.extra) {
    const foot = document.createElement('div');
    foot.className = 'home-favourite-foot';
    foot.append(options.extra, button);
    body.append(foot);
  } else {
    body.append(button);
  }
  card.append(media, body);
  return card;
}

const favouriteCard = renderHomeFavouriteCard;

registerWidget({
  id: 'favourites', order: 50, title: COPY.home.favourites,
  cacheKeys(ctx) { return uniqueGymIds(ctx.gyms).map((id) => gymCacheKey('/api/favourites', id)); },
  async load(ctx) { return loadHomeFavourites(ctx); },
  // Event objects alone do not change when a release instant passes. Include
  // the time-derived status/action so a foreground refresh moves Auto-Book to
  // Quick book and updates relative release copy at the right moment.
  dataSignature(data) {
    return {
      state: data?.state,
      rows: data?.rows || [],
      dynamic: (data?.rows || []).map((event) => ({
        status: getHomeFavouriteStatus(event),
        action: data.primaryActionForEvent?.(event),
      })),
    };
  },
  isEmpty: (data) => data?.state === 'empty',
  emptyText: COPY.home.favouritesNone,
  render(el, data) {
    // The widget-level cache probe owns cold skeletons. Timetable availability
    // may still be hydrating while cached favourites are already available.
    if (data.state === 'loading') return;
    const strip = document.createElement('div');
    strip.className = 'home-favourites-strip';
    strip.setAttribute('aria-label', COPY.home.favourites);
    data.rows.forEach((event) => strip.appendChild(favouriteCard(event, data.primaryActionForEvent, data.actionGlyph)));
    el.appendChild(strip);
  },
});

/**
 * One most-frequent instructor per linked gym. History has no photo by design,
 * so pair its normalized instructor id with that gym's normalized metadata;
 * metadata photo URLs are the F-15 same-origin proxy URLs.
 */
export function getHomeTopInstructorRows(gyms, byGym = {}) {
  if (!Array.isArray(gyms)) return [];
  return gyms.flatMap((gym) => {
    const gymId = gymIdOf(gym);
    const top = byGym[gymId]?.history?.topInstructors?.[0];
    if (!gymId || !top?.instructorId || !top?.instructorName) return [];
    const instructor = (byGym[gymId]?.metadata?.instructors || [])
      .find((item) => String(item.id) === String(top.instructorId));
    return [{
      gymId,
      gymName: getGymShortName(gymId) || gym.shortName || gym.name || gymId,
      instructorId: String(top.instructorId),
      instructorName: top.instructorName,
      count: Number(top.count) || 0,
      photoUrl: instructor?.thumbUrl || instructor?.imageUrl || null,
      href: buildTimetableUrl({ gym: [gymId], instructor: [`${gymId}:${top.instructorId}`] }),
    }];
  });
}

async function loadHomeTopInstructors(gyms) {
  const linked = (Array.isArray(gyms) ? gyms : []).filter((gym) => gymIdOf(gym));
  const settled = await Promise.allSettled(linked.map(async (gym) => {
    const gymId = gymIdOf(gym);
    const history = await api.getHistory(gymId, { days: 30, limit: 1, top: 1, loading: true });
    // A missing photo must not turn a useful history answer into a widget error.
    const metadata = await api.getMetadata({ gymId, ttlMs: 300000, loading: true }).catch(() => ({ instructors: [] }));
    return [gymId, { history, metadata }];
  }));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled');
  if (!fulfilled.length && linked.length) throw settled.find((result) => result.status === 'rejected')?.reason;
  return getHomeTopInstructorRows(gyms, Object.fromEntries(fulfilled.map((result) => result.value)));
}

registerWidget({
  id: 'top-instructors', order: 80, title: COPY.home.topInstructors,
  cacheKeys(ctx) {
    return uniqueGymIds(ctx.gyms).flatMap((id) => [
      gymCacheKey('/api/history', id, { days: '30', limit: '1', top: '1' }),
      gymCacheKey('/api/metadata', id),
    ]);
  },
  async load(ctx) { return loadHomeTopInstructors(ctx.gyms); },
  isEmpty: (rows) => Array.isArray(rows) && rows.length === 0,
  emptyText: COPY.home.topInstructorsNone,
  render(el, rows) {
    const list = document.createElement('div');
    list.className = 'home-instructor-list';
    for (const row of rows) {
      const anchor = document.createElement('a');
      anchor.className = 'home-instructor-card';
      anchor.href = row.href;
      anchor.setAttribute('aria-label', `${row.instructorName} · ${row.gymName}`);
      anchor.innerHTML = `<span class="home-instructor-identities"><span class="home-instructor-photo"></span><span class="home-instructor-gym"></span></span><span class="home-instructor-text"><span class="home-instructor-name"></span><span class="home-instructor-meta"></span></span>`;
      const photo = anchor.querySelector('.home-instructor-photo');
      const avatar = instructorAvatar(
        row.instructorName, row.gymId, row.photoUrl, { size: 52, cls: 'home-instructor-avatar' },
      );
      if (avatar) photo.innerHTML = avatar;
      else {
        photo.classList.add('is-initial');
        photo.textContent = String(row.instructorName).trim().charAt(0).toUpperCase() || '?';
      }
      anchor.querySelector('.home-instructor-name').textContent = row.instructorName;
      anchor.querySelector('.home-instructor-meta').textContent = row.count === 1
        ? COPY.home.topInstructorClassOne
        : COPY.home.topInstructorClassMany.replace('{count}', String(row.count));
      anchor.querySelector('.home-instructor-gym').innerHTML = gymSquareChip(row.gymId);
      addTimetableLinkHandler(anchor, row.href);
      list.appendChild(anchor);
    }
    el.appendChild(list);
  },
});

let host = null;
let renderRun = 0;

// Mobile reading order comes from the widget registry: each section's data-widget-order,
// which mountWidget sets from the widget's order or orderFor(outcome). Desktop keeps its two
// columns in their own fixed order, except that a widget the registry has placed LAST
// (order >= HOME_ORDER_LAST, e.g. the no-Team "Create a Team" card) leaves its column for
// a tail row under BOTH columns (owner: "the bottom of the other widgets"), at its
// column's width.
const HOME_LEFT_COLUMN_ORDER = ['upcoming', 'teams', 'book', 'stats'];
const HOME_RIGHT_COLUMN_ORDER = ['credits', 'favourites', 'top-instructors'];

/** Pure: [{ id, order }] (effective registry orders) -> { mobile, left, right, tail } id lists. */
export function homeLayout(entries) {
  const list = (entries || []).filter((e) => e && e.id);
  const mobile = orderIds(list);
  const orderOf = new Map(list.map((e) => [e.id, e.order]));
  const present = new Set(mobile);
  const isLast = (id) => orderOf.get(id) >= HOME_ORDER_LAST;
  const column = (ids) => ids.filter((id) => present.has(id) && !isLast(id));
  const known = new Set([...HOME_LEFT_COLUMN_ORDER, ...HOME_RIGHT_COLUMN_ORDER]);
  return {
    mobile,
    left: column(HOME_LEFT_COLUMN_ORDER),
    right: column([...HOME_RIGHT_COLUMN_ORDER, ...mobile.filter((id) => !known.has(id))]),
    tail: mobile.filter(isLast),
  };
}
const sectionEntries = (widgets) => widgets.map((w) => {
  const id = w.dataset.widgetId;
  const own = Number(w.dataset.widgetOrder);
  const def = registry.get(id);
  return { id, order: Number.isFinite(own) && w.dataset.widgetOrder !== '' && w.dataset.widgetOrder != null ? own : (def ? def.order : 100) };
});

/**
 * Keep the registry's reading order on mobile while giving desktop its two
 * independent vertical flows. Moving the existing sections preserves their
 * mounted DOM, actions and widget run tokens across a breakpoint change.
 */
export function syncHomeDesktopFlow(root) {
  if (!root || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const currentMedia = window.matchMedia('(min-width: 769px)');
  const media = root._homeDesktopMedia;
  if (!media || media.matches !== currentMedia.matches) {
    if (media && root._homeDesktopMediaListener) {
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', root._homeDesktopMediaListener);
      else media.removeListener?.(root._homeDesktopMediaListener);
    }
    root._homeDesktopMedia = currentMedia;
    const onChange = () => syncHomeDesktopFlow(root);
    if (typeof currentMedia.addEventListener === 'function') currentMedia.addEventListener('change', onChange);
    else currentMedia.addListener?.(onChange);
    root._homeDesktopMediaListener = onChange;
  }
  const activeMedia = root._homeDesktopMedia;

  const widgets = [...root.querySelectorAll('.home-widget')];
  const layout = homeLayout(sectionEntries(widgets));
  if (!activeMedia.matches) {
    const byId = new Map(widgets.map((widget) => [widget.dataset.widgetId, widget]));
    layout.mobile.forEach((id) => {
      const widget = byId.get(id);
      if (widget) root.appendChild(widget);
    });
    root.querySelectorAll(':scope > .home-desktop-column, :scope > .home-desktop-tail').forEach((column) => column.remove());
    return;
  }

  let left = root.querySelector(':scope > .home-desktop-column--left');
  let right = root.querySelector(':scope > .home-desktop-column--right');
  if (!left || !right) {
    left = document.createElement('div');
    left.className = 'home-desktop-column home-desktop-column--left';
    right = document.createElement('div');
    right.className = 'home-desktop-column home-desktop-column--right';
    root.append(left, right);
  }
  const byId = new Map(widgets.map((widget) => [widget.dataset.widgetId, widget]));
  layout.left.forEach((id) => { const widget = byId.get(id); if (widget) left.appendChild(widget); });
  layout.right.forEach((id) => { const widget = byId.get(id); if (widget) right.appendChild(widget); });
  // Widgets placed last get a row of their own under both columns (only while there are any).
  let tail = root.querySelector(':scope > .home-desktop-tail');
  if (layout.tail.length) {
    if (!tail) { tail = document.createElement('div'); tail.className = 'home-desktop-tail'; }
    root.appendChild(tail); // always after the two columns
    layout.tail.forEach((id) => { const widget = byId.get(id); if (widget) tail.appendChild(widget); });
  } else if (tail) tail.remove();
}

function widgetCopy() {
  return { empty: COPY.home.comingSoon, error: COPY.home.error, retry: COPY.home.retry, noGym: COPY.home.noGymWidget };
}

function renderConnectGym(root) {
  clearHomeUpcomingStrip();
  root.innerHTML = `<div class="home-connect-gym"><h4></h4><p></p><button type="button" class="home-connect-btn"></button></div>`;
  const allDisabled = getAllLinkedGyms().length > 0;
  root.querySelector('h4').textContent = allDisabled ? 'Your gyms are turned off' : COPY.home.connectGymTitle;
  root.querySelector('p').textContent = allDisabled ? 'Turn a gym back on in Settings to see its classes, bookings and credits.' : COPY.home.connectGymBody;
  const b = root.querySelector('button');
  b.textContent = allDisabled ? 'Open Settings' : COPY.home.connectGymAction;
  b.addEventListener('click', () => goTo('settings'));
}

/** (Re)paint the whole page. Safe to call repeatedly; a newer call supersedes an older one. */
export async function renderHome() {
  host = host || document.getElementById('app-home-widgets');
  if (!host) return;
  const run = ++renderRun;
  const gyms = getLinkedGyms();
  const contextKey = homeContextKey(gyms);
  const previousKey = host.dataset.homeContextKey || '';
  if (previousKey !== contextKey) {
    clearHomeUpcomingStrip();
    host.replaceChildren();
    host.dataset.homeContextKey = contextKey;
  }
  let settings = null;
  try { settings = await api.getSettings(); } catch (_) { /* neutral greeting */ }
  if (run !== renderRun) return;
  paintHomeGreeting(settings);
  if (Array.isArray(gyms) && gyms.length === 0) { renderConnectGym(host); return; }
  const ctx = { gyms, allGyms: getAllLinkedGyms(), navigate: goTo, openGymSettings, contextKey };
  const widgets = registry.list(ctx);
  const skeleton = () => renderCardSkeletons(1, COPY.home.loadingWidget);
  // syncHomeDesktopFlow nests sections inside columns; include those mounted
  // sections so a refresh moves/reuses them instead of appending duplicates.
  const existing = new Map([...host.querySelectorAll('.home-widget')].map((el) => [el.dataset.widgetId, el]));
  // A widget whose outcome moves it (orderFor, e.g. the Teams empty card) re-flows the page
  // once every section is in place; before that the final syncHomeDesktopFlow below does it.
  let placed = false;
  const onPlaced = () => { if (placed && run === renderRun) syncHomeDesktopFlow(host); };
  for (const w of widgets) {
    const el = existing.get(w.id) || document.createElement('section');
    el.classList.add('home-widget');
    el.dataset.widgetId = w.id;
    host.appendChild(el);
    existing.delete(w.id);
    mountWidget(el, w, ctx, {
      skeleton,
      copy: widgetCopy(),
      contextKey,
      onPlaced,
      hasCachedData: async (widget) => {
        const keys = typeof widget.cacheKeys === 'function' ? widget.cacheKeys(ctx) : [];
        if (!keys.length) return false;
        const rows = await Promise.all(keys.map((key) => readCached(key)));
        return rows.every(Boolean);
      },
    }); // independent; never awaited together
  }
  existing.forEach((el) => el.remove());
  placed = true;
  syncHomeDesktopFlow(host);
}

export function initHome() { return renderHome(); }
export const refreshHome = renderHome;

export { isNoGymError };

// Re-render when the linked-gym set changes, and when the app returns to the foreground.
if (typeof window !== 'undefined') {
  const onHome = () => !!document.getElementById('app-panel-home') && document.getElementById('app-panel-home').style.display !== 'none';
  window.addEventListener('app:gyms-changed', () => { if (onHome()) renderHome(); });
  window.addEventListener('app-favourites-changed', () => { if (onHome()) renderHome(); });
  window.addEventListener('app-timetable-rendered', () => { if (onHome()) renderHome(); });
  // booking-state dispatches only after it has refreshed the shared cache and
  // the corresponding Home SWR row, so this repaint never reuses a 120s-old
  // booking response after a successful booking.
  window.addEventListener('app-booking-state-changed', () => { if (onHome()) renderHome(); });
  let refreshQueued = false;
  window.addEventListener('app-data-refreshed', (event) => {
    if (!onHome() || refreshQueued) return;
    const endpoint = String(event.detail?.endpoint || '');
    if (!endpoint.startsWith('/api/')) return;
    refreshQueued = true;
    queueMicrotask(() => { refreshQueued = false; if (onHome()) renderHome(); });
  });
  window.addEventListener('app-user-data-refreshed', () => {
    if (onHome()) renderHome();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && onHome()) renderHome(); });
}
