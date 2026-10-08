// Home tab: a page of independent widgets (F-10-1).
// Framework lives in widget-registry.js; this file registers the widgets and paints the page.
import { api } from '../api.js';
import { COPY } from '../copy.js';
import { registerWidget, registry, mountWidget, isNoGymError } from './widget-registry.js';
import { renderCardSkeletons } from './loading-skeleton.js';
import { welcomeText } from './name-capture.js';
import { getTotalCredits, hasConfirmedAccess, isMetered } from './credit-allowance.js';
import { canForGym, getGymShortName } from '../gym-context.js';
import { gymSquareChip } from './cards.js';
import { buildTimetableUrl } from '../url-state.js';
import { navigate } from '../router.js';
import { DateTime } from 'luxon';
import { groupBookingsByEvent, selectUpcoming } from './upcoming.js';
import { mountBookingCard } from './bookings.js';
import { formatInZone, zoneFor } from '../lib.js';
import { instructorAvatar } from './tooltips.js';
import { indexFavourites, isFavouriteIn } from '../favourites.js';

const goTo = (tabId) => (window.switchTab ? window.switchTab(tabId) : null);

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

const finite = (value) => Number.isFinite(Number(value));

/** A compact duration label without claiming a provider's unit semantics. */
export function formatStatsMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return '';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/**
 * Keep provided attendance and history-derived bookings in distinct buckets.
 * It is tempting to add the two, but that would present non-equivalent source
 * semantics as one cross-gym "classes taken" total.
 */
export function getHomeStats(gyms, byGym = {}) {
  const rows = [];
  for (const gym of Array.isArray(gyms) ? gyms : []) {
    const gymId = gymIdOf(gym);
    if (!gymId) continue;
    const data = byGym[gymId] || {};
    const attendance = data.attendance;
    const summary = data.history?.summary;
    const profileStats = data.profile?.stats;
    const hasOfficial = finite(attendance?.attendedTotal);
    const hasHistory = finite(summary?.classCount);
    if (!hasOfficial && !hasHistory) continue;
    const providerMinutes = finite(profileStats?.totalAttendedMinutes)
      ? Number(profileStats.totalAttendedMinutes) : null;
    const historyMinutes = finite(summary?.totalMinutes) ? Number(summary.totalMinutes) : null;
    rows.push({
      gymId,
      gymName: getGymShortName(gymId) || gym.shortName || gym.name || gymId,
      attendanceTotal: hasOfficial ? Number(attendance.attendedTotal) : null,
      bookedCount: !hasOfficial && hasHistory ? Number(summary.classCount) : null,
      // Prefer the provider's attended-minute figure. Only use history minutes
      // where a provider does not expose that value.
      minutes: providerMinutes ?? (!hasOfficial ? historyMinutes : null),
      minutesSource: providerMinutes != null ? 'provider' : (!hasOfficial && historyMinutes != null ? 'history' : null),
      instructorCount: finite(summary?.instructorCount) ? Number(summary.instructorCount) : null,
    });
  }
  const officialAttendedTotal = rows.reduce((sum, row) => sum + (row.attendanceTotal || 0), 0);
  const historyBookedTotal = rows.reduce((sum, row) => sum + (row.bookedCount || 0), 0);
  return { rows, officialAttendedTotal, historyBookedTotal };
}

async function loadHomeStats(gyms) {
  const linked = (Array.isArray(gyms) ? gyms : []).filter((gym) => gymIdOf(gym));
  const settled = await Promise.allSettled(linked.map(async (gym) => {
    const gymId = gymIdOf(gym);
    // Capabilities are held by gym-context while public linked-gym rows stay
    // deliberately small. Resolve this known gym through that shared contract.
    const supportsOfficialAttendance = canForGym('attendanceTotals', gymId);
    const [history, attendance, profile] = await Promise.allSettled([
      api.getHistory(gymId, { limit: 1, top: 0 }),
      supportsOfficialAttendance ? api.getAttendanceTotals(gymId) : Promise.resolve(null),
      supportsOfficialAttendance ? api.getNormalizedProfile(gymId) : Promise.resolve(null),
    ]);
    const historyValue = history.status === 'fulfilled' ? history.value : null;
    const data = {
      history: historyValue && (!historyValue.sync?.lastError || historyValue.sync?.lastSyncedAt) ? historyValue : null,
      attendance: attendance.status === 'fulfilled' ? attendance.value : null,
      profile: profile.status === 'fulfilled' ? profile.value : null,
      partial: history.status === 'rejected' || !!historyValue?.sync?.lastError || attendance.status === 'rejected' || profile.status === 'rejected',
    };
    const hasData = !!data.history || !!data.attendance;
    if (!hasData) throw new Error('No stats source available');
    return [gymId, data];
  }));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled');
  if (!fulfilled.length && linked.length) throw settled.find((result) => result.status === 'rejected')?.reason;
  const model = getHomeStats(gyms, Object.fromEntries(fulfilled.map((result) => result.value)));
  return { ...model, partial: fulfilled.length !== linked.length || fulfilled.some((result) => result.value[1].partial) };
}

function statsMetric(label, value, source) {
  const metric = document.createElement('div');
  metric.className = 'home-stats-metric';
  const number = document.createElement('strong');
  number.textContent = String(value);
  const copy = document.createElement('span');
  copy.textContent = label;
  metric.append(number, copy);
  if (source) metric.dataset.source = source;
  return metric;
}

function statsRow(row) {
  const detailId = `home-stats-${row.gymId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const item = document.createElement('div');
  item.className = 'home-stats-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'home-stats-row-toggle';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', detailId);
  const primary = row.attendanceTotal != null
    ? `${row.attendanceTotal} · ${COPY.home.statsProviderAttended}`
    : `${row.bookedCount} · ${COPY.home.statsHistoryBooked}`;
  button.innerHTML = '<span class="home-stats-gym"></span><span class="home-stats-primary"></span><span class="home-stats-chevron" aria-hidden="true">⌄</span>';
  button.querySelector('.home-stats-gym').textContent = row.gymName;
  button.querySelector('.home-stats-primary').textContent = primary;
  const details = document.createElement('div');
  details.id = detailId;
  details.className = 'home-stats-details';
  details.hidden = true;
  if (row.attendanceTotal != null) details.appendChild(statsMetric(COPY.home.statsProviderAttended, row.attendanceTotal, 'provider'));
  if (row.bookedCount != null) details.appendChild(statsMetric(COPY.home.statsHistoryBooked, row.bookedCount, 'history'));
  if (row.minutes != null) details.appendChild(statsMetric(
    row.minutesSource === 'provider' ? COPY.home.statsProviderMinutes : COPY.home.statsHistoryMinutes,
    formatStatsMinutes(row.minutes), row.minutesSource,
  ));
  if (row.instructorCount != null) details.appendChild(statsMetric(COPY.home.statsHistoryInstructors, row.instructorCount, 'history'));
  button.setAttribute('aria-label', COPY.home.statsShowDetails.replace('{gym}', row.gymName));
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    button.setAttribute('aria-label', (expanded ? COPY.home.statsShowDetails : COPY.home.statsHideDetails).replace('{gym}', row.gymName));
    details.hidden = expanded;
  });
  item.append(button, details);
  return item;
}

registerWidget({
  id: 'stats', order: 80, title: COPY.home.stats,
  async load(ctx) { return loadHomeStats(ctx.gyms); },
  isEmpty: (data) => Array.isArray(data?.rows) && data.rows.length === 0,
  emptyText: COPY.home.statsNone,
  render(el, data) {
    const summary = document.createElement('div');
    summary.className = 'home-stats-summary';
    if (data.rows.some((row) => row.attendanceTotal != null)) summary.appendChild(statsMetric(COPY.home.statsProviderAttended, data.officialAttendedTotal, 'provider'));
    if (data.rows.some((row) => row.bookedCount != null)) summary.appendChild(statsMetric(COPY.home.statsHistoryBooked, data.historyBookedTotal, 'history'));
    // A known zero is still meaningful. The rows below retain its source label.
    if (!summary.children.length) summary.textContent = COPY.home.statsNone;
    const list = document.createElement('div');
    list.className = 'home-stats-list';
    data.rows.forEach((row) => list.appendChild(statsRow(row)));
    el.append(summary, list);
    if (data.partial) {
      const note = document.createElement('p');
      note.className = 'home-stats-partial';
      note.textContent = COPY.home.statsPartial;
      el.appendChild(note);
    }
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

async function loadHomeFavourites(gyms) {
  const [{ cache }, timetable] = await Promise.all([
    import('../main.js'), import('./timetable.js'),
  ]);
  const gymIds = [...new Set((Array.isArray(gyms) ? gyms : []).map(gymIdOf).filter(Boolean))];
  const missing = gymIds.filter((gymId) => !cache.favouritesByGym?.[gymId]);
  if (missing.length) {
    const settled = await Promise.allSettled(missing.map((gymId) => api.getFavourites(gymId)));
    cache.favouritesByGym = { ...(cache.favouritesByGym || {}) };
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled' && Array.isArray(result.value?.favourites)) {
        cache.favouritesByGym[missing[index]] = indexFavourites(result.value.favourites);
      }
    });
  }
  const events = timetable.getLoadedEvents();
  if (!events.length) timetable.ensureScheduleLoaded();
  return {
    ...getHomeFavouriteRows(gyms, {
      favouritesByGym: cache.favouritesByGym,
      events,
      scheduleLoading: timetable.isScheduleLoading(),
    }),
    primaryActionForEvent: timetable.primaryActionForEvent,
  };
}

function favouriteCard(event, primaryActionForEvent) {
  const zone = zoneFor(event);
  const dt = DateTime.fromISO(String(event.startAt), { setZone: true }).setZone(zone);
  const card = document.createElement('article');
  card.className = 'home-favourite-card';
  const photo = event.instructors?.[0]?.thumbUrl || event.instructors?.[0]?.imageUrl || null;
  card.innerHTML = '<div class="home-favourite-photo"></div><div class="home-favourite-copy"><span class="home-favourite-when"></span><span class="home-favourite-type"></span></div><button type="button" class="home-favourite-cta"></button>';
  const photoEl = card.querySelector('.home-favourite-photo');
  const avatar = instructorAvatar(event.instructors?.[0]?.name || '', event.gymId, photo, { size: 56, cls: 'home-favourite-avatar' });
  if (avatar) photoEl.innerHTML = avatar;
  else {
    photoEl.classList.add('is-initial');
    photoEl.textContent = String(event.instructors?.[0]?.name || '').trim().charAt(0).toUpperCase() || '?';
  }
  photoEl.insertAdjacentHTML('beforeend', `<span class="home-favourite-gym">${gymSquareChip(event.gymId)}</span>`);
  card.querySelector('.home-favourite-when').textContent = `${dt.isValid ? dt.toFormat('ccc') : ''} ${formatInZone(event.startAt, zone).timeLabel}`.trim();
  card.querySelector('.home-favourite-type').textContent = event.discipline || event.name || COPY.common.classFallback;
  const action = primaryActionForEvent(event);
  const button = card.querySelector('.home-favourite-cta');
  button.classList.add(`variant-${action.variant}`);
  button.textContent = action.label;
  if (action.title) { button.title = action.title; button.setAttribute('aria-label', action.title); }
  if (action.disabled) button.disabled = true;
  else if (action.run) button.addEventListener('click', () => action.run(button));
  return card;
}

registerWidget({
  id: 'favourites', order: 60, title: COPY.home.favourites,
  async load(ctx) { return loadHomeFavourites(ctx.gyms); },
  isEmpty: (data) => data?.state === 'empty',
  emptyText: COPY.home.favouritesNone,
  render(el, data) {
    if (data.state === 'loading') {
      el.innerHTML = renderCardSkeletons(2, COPY.home.loadingWidget);
      return;
    }
    const strip = document.createElement('div');
    strip.className = 'home-favourites-strip';
    strip.setAttribute('aria-label', COPY.home.favourites);
    data.rows.forEach((event) => strip.appendChild(favouriteCard(event, data.primaryActionForEvent)));
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
    const history = await api.getHistory(gymId, { days: 30, limit: 1, top: 1 });
    // A missing photo must not turn a useful history answer into a widget error.
    const metadata = await api.getMetadata({ gymId }).catch(() => ({ instructors: [] }));
    return [gymId, { history, metadata }];
  }));
  const fulfilled = settled.filter((result) => result.status === 'fulfilled');
  if (!fulfilled.length && linked.length) throw settled.find((result) => result.status === 'rejected')?.reason;
  return getHomeTopInstructorRows(gyms, Object.fromEntries(fulfilled.map((result) => result.value)));
}

registerWidget({
  id: 'top-instructors', order: 70, title: COPY.home.topInstructors,
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
      anchor.innerHTML = `<span class="home-instructor-photo"></span><span class="home-instructor-text"><span class="home-instructor-name"></span><span class="home-instructor-meta"></span></span><span class="home-instructor-gym"></span>`;
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
  host = host || document.getElementById('app-home-widgets');
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
  const onHome = () => !!document.getElementById('app-panel-home') && document.getElementById('app-panel-home').style.display !== 'none';
  window.addEventListener('app:gyms-changed', () => { if (onHome()) renderHome(); });
  window.addEventListener('app-favourites-changed', () => { if (onHome()) renderHome(); });
  window.addEventListener('app-timetable-rendered', () => { if (onHome()) renderHome(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && onHome()) renderHome(); });
}
