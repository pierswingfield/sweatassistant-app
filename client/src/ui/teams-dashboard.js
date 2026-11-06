// T-3 Team dashboard widgets (PLAN-teams.md §5.3): Today's workouts, This week, Classes
// together and Members, rendered from ONE projection payload (GET /api/teams/:id/today).
//
// Privacy: the server already decided what this viewer may see (§2 principle 1,
// server/team-projection.js); nothing here filters. Every user or gym string goes
// through escapeHtml or textContent. Members are addressed only by memberRef.
// Booking never takes a new path: Classes together delegates to the timetable's own
// action model (primaryActionForEvent), exactly as the Home favourite card does.
//
// Each widget renders inside its own try/catch, so one failing never blanks a sibling
// (the widget-registry rule, §5.3).

import { DateTime } from 'luxon';
import { escapeHtml, gymSquareChip, gymBrand } from './cards.js';
import { formatInZone, deviceZone } from '../lib.js';
import { getAllLinkedGyms, getGymShortName } from '../gym-context.js';
import { renderHomeFavouriteCard, isDisabledLinkedGym } from './home.js';
import {
  T, fmt, avatarHtml, avatarStackHtml, ICONS, captainBadgeHtml, openTeamsPage,
} from './teams-ui.js';
import {
  sortMembers, paginate, readSortChoice, writeSortChoice, SORT_MODES, MEMBERS_PER_PAGE, relativeTime,
} from './teams-model.js';
import {
  todaysWorkouts, weekDays, initialDayIndex, visibleWeekRows, classesTogether, memberActivity,
  activityScore, heroState, namesList, ctaKind, memberProfile, statusAt,
} from './teams-dashboard-model.js';
import { weekChange, streakView, busiestDaysView, busiestTimesView, gymMixView } from './teams-stats-model.js';

const SORT_LABEL = { name: 'sortName', activity: 'sortActivity', shuffle: 'sortShuffle' };

function storage() {
  try { return window.localStorage; } catch (_) { return null; }
}

// ---- shared bits ---------------------------------------------------------------------------

function timeOf(c) { return formatInZone(c.startAt, c.timeZone || deviceZone()).timeLabel; }

function endTimeOf(c) {
  const start = DateTime.fromISO(String(c.startAt), { setZone: true });
  const end = start.plus({ minutes: Number(c.durationMin) > 0 ? Number(c.durationMin) : 45 });
  return formatInZone(end.toISO(), c.timeZone || deviceZone()).time;
}

function whenLabel(c, now) {
  const zone = c.timeZone || deviceZone();
  const f = formatInZone(c.startAt, zone);
  const d = DateTime.fromISO(String(c.startAt), { setZone: true }).setZone(zone);
  const today = DateTime.fromMillis(now, { zone });
  if (d.hasSame(today, 'day')) return `${T.weekToday.toLowerCase()} ${f.timeLabel}`;
  if (d.hasSame(today.plus({ days: 1 }), 'day')) return `${T.tomorrow.toLowerCase()} ${f.timeLabel}`;
  return `${d.toFormat('ccc')} ${f.timeLabel}`;
}

const placeOf = (c) => c.locationName || c.studioName || '';

/** "<b>Ana</b> · Bike 14, <b>Sam</b>" (escaped). The viewer reads as "You". */
function attendeesHtml(c, byRef, { kinds = ['booked', 'waitlist', 'queued'] } = {}) {
  return (c.attendees || []).filter((a) => kinds.includes(a.kind)).map((a) => {
    const m = byRef.get(a.memberRef);
    if (!m) return '';
    const name = m.isMe ? T.you : m.name;
    let out = `<b>${escapeHtml(name)}</b>`;
    if (a.spot) out += `<span class="tm-muted">${escapeHtml(T.spotSep)}${escapeHtml(a.spot)}</span>`;
    if (a.kind === 'waitlist') out += ` <span class="tm-muted">(${escapeHtml(T.waitlistTag)})</span>`;
    if (a.kind === 'queued') out += ` <span class="tm-muted">(${escapeHtml(T.queuedTag)})</span>`;
    return out;
  }).filter(Boolean).join(', ');
}

function attendeeMembers(c, byRef, kinds = ['booked']) {
  return (c.attendees || []).filter((a) => kinds.includes(a.kind)).map((a) => byRef.get(a.memberRef)).filter(Boolean);
}

function progressRingHtml(fraction, label, aria) {
  const r = 20;
  const circ = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, fraction));
  return `<span class="tm-pring" role="img" aria-label="${escapeHtml(aria)}"><svg viewBox="0 0 48 48" aria-hidden="true"><circle class="tm-pring-track" cx="24" cy="24" r="${r}"/><circle class="tm-pring-prog" cx="24" cy="24" r="${r}" stroke-dasharray="${(f * circ).toFixed(1)} ${circ.toFixed(1)}"/></svg><span>${escapeHtml(label)}</span></span>`;
}

// ---- header state (§5.3 item 1) ------------------------------------------------------------

export function heroLines(data, now) {
  const h = heroState(data, { now });
  const names = h.inClass.map((m) => (m.isMe ? T.you : m.name));
  let state = '';
  if (names.length) {
    const list = namesList(names, { and: T.and, more: T.nMore });
    state = fmt(names.length === 1 && !h.inClass[0].isMe ? T.heroInClassOne : T.heroInClassMany, { names: list });
  } else if (h.inProgress > 0) {
    state = fmt(T.heroInClassCount, { count: h.inProgress });
  }
  const sub = h.total > 0 ? fmt(T.heroDoneOf, { done: h.done, total: h.total }) : T.heroRest;
  return { state, sub };
}

// ---- Today's workouts (§5.3 item 2) ----------------------------------------------------------

/** @returns {boolean} false when there is nothing today (the widget disappears). */
export function renderTodaysWorkouts(section, data, now) {
  const rows = todaysWorkouts(data.classes, { now });
  if (!rows.length) { section.hidden = true; section.innerHTML = ''; return false; }
  section.hidden = false;
  const byRef = new Map(data.members.map((m) => [m.memberRef, m]));
  const dateLabel = DateTime.fromMillis(now, { zone: deviceZone() }).toFormat('ccc d LLL');
  const row = ({ cls: c, status, progress, minutesLeft }) => {
    const title = `${escapeHtml(c.className)}${placeOf(c) ? ` · ${escapeHtml(placeOf(c))}` : ''}`;
    const who = attendeesHtml(c, byRef, { kinds: ['booked'] });
    if (status === 'done') {
      return `<li class="tm-tw is-done"><span class="tm-tw-lead"><span class="tm-tw-check" aria-hidden="true">${ICONS.check}</span></span>
        <span class="tm-grow tm-min0"><span class="tm-tw-title">${escapeHtml(timeOf(c))} ${title}</span><span class="tm-tw-who">${who} <span class="tm-muted">· ${escapeHtml(T.doneWord)}</span></span></span></li>`;
    }
    if (status === 'inProgress') {
      return `<li class="tm-tw is-live"><span class="tm-tw-lead">${progressRingHtml(progress, fmt(T.minLeft, { n: minutesLeft }), fmt(T.minLeftAria, { n: minutesLeft }))}</span>
        <span class="tm-grow tm-min0"><span class="tm-tw-kicker"><span class="tm-live-dot" aria-hidden="true"></span>${escapeHtml(T.inClass)} <span class="tm-muted">${escapeHtml(timeOf(c))}–${escapeHtml(endTimeOf(c))}</span></span>
        <span class="tm-tw-title">${title}</span><span class="tm-tw-who">${who}</span></span></li>`;
    }
    return `<li class="tm-tw"><span class="tm-tw-lead tm-tw-time">${escapeHtml(timeOf(c))}</span>
      <span class="tm-grow tm-min0"><span class="tm-tw-title">${title}</span><span class="tm-tw-who">${who}</span></span></li>`;
  };
  section.innerHTML = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.todaysWorkouts)}</h3><span class="tm-grow"></span><span class="tm-card-meta">${escapeHtml(dateLabel)}</span></div>
    <ul class="tm-tw-list">${rows.map(row).join('')}</ul>`;
  return true;
}

// ---- This week (§5.3 item 3) ----------------------------------------------------------------

export function renderThisWeek(section, data, now) {
  const zone = deviceZone();
  const days = weekDays(data.classes, { now, zone });
  const byRef = new Map(data.members.map((m) => [m.memberRef, m]));
  let selected = initialDayIndex(days, now);
  let expanded = false;

  const dayBtn = (d, i) => {
    const dots = d.memberRefs.slice(0, 5).map((r) => byRef.get(r)).filter(Boolean)
      .map((m) => `<i class="tm-av-c${Number(m.colourIndex) || 0}"></i>`).join('');
    const aria = fmt(T.weekDayAria, { day: `${d.isToday ? T.weekToday : d.weekday} ${d.dayNum}`, count: d.classes.length });
    return `<button type="button" role="tab" class="tm-wday${i === selected ? ' is-on' : ''}${d.classes.length ? ' has-classes' : ''}" data-day="${i}" aria-selected="${i === selected}" aria-label="${escapeHtml(aria)}">
      <span class="tm-wday-name">${escapeHtml(d.weekday)}</span><span class="tm-wday-num">${d.dayNum}</span><span class="tm-wday-dots" aria-hidden="true">${dots}</span></button>`;
  };

  const rowHtml = (c) => {
    const people = attendeeMembers(c, byRef, ['booked', 'waitlist', 'queued']);
    return `<li class="tm-wrow${statusAt(c, now) === 'done' ? ' is-done' : ''}">
      <div class="tm-wrow-head"><span class="tm-wrow-time">${escapeHtml(timeOf(c))}</span><span class="tm-wrow-name tm-ellip">${escapeHtml(c.className)}</span></div>
      <div class="tm-wrow-sub">${c.instructorName ? `<span class="tm-wrow-inst">${escapeHtml(c.instructorName)}</span><span class="tm-wrow-sep" aria-hidden="true">·</span>` : ''}${avatarStackHtml(people, { max: 4 })}<span class="tm-wrow-who">${attendeesHtml(c, byRef)}</span></div>
    </li>`;
  };

  const paint = () => {
    const d = days[selected];
    const heading = DateTime.fromISO(d.date, { zone }).toFormat('cccc d LLLL');
    const { rows, hidden } = visibleWeekRows(d.classes, expanded);
    section.innerHTML = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.thisWeek)}</h3></div>
      <div class="tm-week" role="tablist" aria-label="${escapeHtml(T.thisWeek)}">${days.map(dayBtn).join('')}</div>
      <p class="tm-week-heading">${d.isToday ? `${escapeHtml(T.weekToday)} · ` : ''}${escapeHtml(heading)}</p>
      ${rows.length ? `<ul class="tm-wrows">${rows.map(rowHtml).join('')}</ul>` : `<p class="tm-muted tm-sm tm-week-empty">${escapeHtml(T.noClassesDay)}</p>`}
      ${hidden ? `<button type="button" class="tm-btn tm-btn-block tm-mt-s" data-more>${escapeHtml(fmt(T.seeMore, { count: hidden }))}</button>` : ''}
      ${expanded && d.classes.length > 3 ? `<button type="button" class="tm-btn tm-btn-ghost tm-btn-block tm-mt-s" data-less>${escapeHtml(T.seeLess)}</button>` : ''}`;
    section.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      selected = Number(b.getAttribute('data-day'));
      expanded = false;
      paint();
      section.querySelector(`[data-day="${selected}"]`)?.focus();
    }));
    section.querySelector('[data-more]')?.addEventListener('click', () => { expanded = true; paint(); });
    section.querySelector('[data-less]')?.addEventListener('click', () => { expanded = false; paint(); });
    const strip = section.querySelector('.tm-week');
    strip.querySelector('.is-on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };
  paint();
}

// ---- Classes together (§5.3 item 4) -----------------------------------------------------------

function syntheticEvent(c) {
  return {
    id: c.eventId, gymId: c.gymId, startAt: c.startAt, timeZone: c.timeZone, name: c.className,
    discipline: c.discipline, instructors: c.instructorName ? [{ name: c.instructorName }] : [], locationName: c.locationName,
  };
}

function disabledGym(gymId) {
  const gym = (getAllLinkedGyms() || []).find((g) => String(g.gym_id || g.gymId || g.id || '') === String(gymId));
  return !!gym && isDisabledLinkedGym(gym);
}

function openGymSettings(gymId) {
  window.switchTab?.('settings');
  import('./settings.js').then((m) => m.openGymSettings(gymId)).catch((err) => console.error('[Teams] open gym settings failed', err));
}

export async function renderClassesTogether(section, data, now, { stale = () => false } = {}) {
  const list = classesTogether(data.classes, { now });
  const byRef = new Map(data.members.map((m) => [m.memberRef, m]));
  const me = data.members.find((m) => m.isMe);
  const head = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.classesTogether)}</h3></div>`;
  if (!list.length) {
    section.innerHTML = `${head}<p class="tm-muted tm-sm">${escapeHtml(T.togetherEmpty)}</p>`;
    return;
  }
  let tt = null;
  try { tt = await import('./timetable.js'); } catch (_) { tt = null; }
  if (stale() || !section.isConnected) return;
  const events = tt ? tt.getLoadedEvents() : [];
  if (tt && !events.length) tt.ensureScheduleLoaded();

  const strip = document.createElement('div');
  strip.className = 'tm-together';
  strip.setAttribute('aria-label', T.classesTogether);
  for (const c of list) {
    const event = events.find((e) => String(e.gymId) === String(c.gymId) && String(e.id) === String(c.eventId)) || null;
    const kind = ctaKind({
      cls: c, myRef: me && me.memberRef, bookedByMe: !!(event && tt && tt.isEventBookedByMe(event)),
      gymDisabled: disabledGym(c.gymId), eventFound: !!event,
    });
    let action;
    if (kind === 'in') action = { label: T.youreIn, variant: 'in', disabled: true };
    else if (kind === 'turnOn') action = { label: fmt(T.turnOnGym, { gym: getGymShortName(c.gymId) || '' }), variant: 'outline', run: () => openGymSettings(c.gymId) };
    else if (kind === 'event') action = tt.primaryActionForEvent(event);
    else action = { label: T.viewInTimetable, variant: 'outline', run: () => window.switchTab?.('timetable') };
    const people = attendeeMembers(c, byRef, ['booked']);
    const extra = document.createElement('span');
    extra.className = 'tm-together-who';
    extra.innerHTML = avatarStackHtml(people, { max: 5 });
    extra.setAttribute('role', 'img');
    extra.setAttribute('aria-label', fmt(T.withTeam, { names: namesList(people.map((m) => (m.isMe ? T.you : m.name)), { and: T.and, more: T.nMore, max: 3 }) }));
    const status = event && kind !== 'turnOn' ? null : { kind: 'unknown', label: placeOf(c) };
    const card = renderHomeFavouriteCard(event || syntheticEvent(c), () => action, kind === 'event' ? tt.actionGlyph : null, { extra, ...(status ? { status } : {}) });
    card.classList.add('tm-together-card');
    strip.appendChild(card);
  }
  section.innerHTML = head;
  section.appendChild(strip);
}

// ---- Members (§5.3 item 5) --------------------------------------------------------------------

function memberLines(m, act, now) {
  const lines = [];
  if (m.counts) {
    const monthName = DateTime.fromMillis(now, { zone: deviceZone() }).toFormat('LLL');
    lines.push({ text: fmt(T.countsLine, { week: m.counts.week, month: m.counts.month, monthName }) });
  } else {
    lines.push({ text: T.countsPrivate, muted: true });
  }
  if (act && act.inClass) {
    lines.push({ text: fmt(T.inClassLine, { cls: act.inClass.className }) + (act.spotIn ? `${T.spotSep}${act.spotIn}` : '') });
  } else if (act && act.next) {
    lines.push({ text: fmt(T.nextLine, { when: whenLabel(act.next, now), cls: act.next.className }) + (act.spotNext ? `${T.spotSep}${act.spotNext}` : '') });
  }
  if (m.stale && m.updatedAt) {
    lines.push({ text: fmt(T.updatedAgo, { ago: relativeTime(m.updatedAt, now, { now: T.timeNow, min: T.timeMin, hour: T.timeHour, yesterday: T.timeYesterday, days: T.timeDays }) }), warn: true });
  }
  return lines;
}

export function renderMembers(section, data, now) {
  const team = data.team;
  const members = data.members || [];
  const activity = memberActivity(members, data.classes, { now });
  let mode = readSortChoice(storage(), team.id);
  const shuffleSeed = `${team.id}:${new Date(now).toISOString().slice(0, 10)}`;

  const memberCard = (m) => {
    const lines = memberLines(m, activity.get(m.memberRef), now);
    // Only gyms the viewer has linked arrive here; nothing marks an unlinked one (T-3 review).
    const chips = (m.gyms || []).map((g) => `<span class="tm-mem-gym" title="${escapeHtml(getGymShortName(g) || '')}">${gymSquareChip(g)}</span>`).join('');
    return `<button type="button" class="tm-mem-card" data-member="${escapeHtml(m.memberRef)}" aria-label="${escapeHtml(fmt(T.openMember, { name: m.isMe ? T.you : m.name }))}">
      ${avatarHtml(m, { size: 'lg', label: false })}
      <span class="tm-grow tm-min0">
        <span class="tm-mem-name"><span class="tm-ellip">${escapeHtml(m.isMe ? T.you : m.name)}</span>${m.isCaptain ? captainBadgeHtml() : ''}</span>
        ${lines.map((l) => `<span class="tm-mem-line${l.muted ? ' tm-muted' : ''}${l.warn ? ' tm-warn' : ''}">${escapeHtml(l.text)}</span>`).join('')}
      </span>
      <span class="tm-mem-gyms">${chips}</span>
    </button>`;
  };

  const paint = () => {
    const sorted = sortMembers(members, mode, { seed: shuffleSeed, activityOf: activityScore });
    const pages = paginate(sorted, MEMBERS_PER_PAGE);
    section.innerHTML = `
      <div class="tm-card-head">
        <h3 class="tm-card-title">${escapeHtml(T.members)}</h3>
        <span class="tm-grow"></span><span class="tm-card-meta">${members.length}</span>
        <div class="tm-sort">
          <button type="button" class="tm-icon-btn tm-sort-btn" data-sort-toggle aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(T.sortMembers)}">${ICONS.sort}</button>
          <div class="tm-menu" role="menu" hidden>
            <div class="tm-menu-cap">${escapeHtml(T.sortBy)}</div>
            ${SORT_MODES.map((s) => `<button type="button" role="menuitemradio" aria-checked="${s === mode}" class="tm-menu-item${s === mode ? ' is-on' : ''}" data-sort="${s}">${s === mode ? ICONS.check : '<span class="tm-menu-gap"></span>'}<span>${escapeHtml(T[SORT_LABEL[s]])}</span></button>`).join('')}
          </div>
        </div>
      </div>
      <div class="tm-pager" tabindex="0" aria-label="${escapeHtml(T.members)}">${pages.map((p, i) => `<div class="tm-page" aria-label="${escapeHtml(fmt(T.membersPage, { n: i + 1, total: pages.length }))}">${p.map(memberCard).join('')}</div>`).join('')}</div>
      ${pages.length > 1 ? `<div class="tm-dots" aria-hidden="true">${pages.map((_, i) => `<i class="${i === 0 ? 'is-on' : ''}"></i>`).join('')}</div>` : ''}`;

    const toggle = section.querySelector('[data-sort-toggle]');
    const menu = section.querySelector('.tm-menu');
    const outside = (e) => { if (!e.target.closest('.tm-sort')) closeMenu(); };
    function closeMenu() { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside, true); }
    toggle.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open) { document.addEventListener('click', outside, true); menu.querySelector('.is-on')?.focus(); }
    });
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); toggle.focus(); } });
    menu.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      mode = b.getAttribute('data-sort');
      writeSortChoice(storage(), team.id, mode);
      closeMenu();
      paint();
    }));
    section.querySelectorAll('[data-member]').forEach((b) => b.addEventListener('click', () => {
      const m = members.find((x) => x.memberRef === b.getAttribute('data-member'));
      if (m) openMemberProfile(m, data, now);
    }));

    const pager = section.querySelector('.tm-pager');
    const dots = section.querySelectorAll('.tm-dots i');
    if (dots.length) {
      pager.addEventListener('scroll', () => {
        const i = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
        dots.forEach((d, j) => d.classList.toggle('is-on', j === i));
      }, { passive: true });
    }
  };
  paint();
}

/** A member's Team-scoped profile: upcoming and recent classes as they shared them (§5.3). */
export function openMemberProfile(m, data, now = Date.now()) {
  const name = m.isMe ? T.you : m.name;
  const page = openTeamsPage({ id: 'team-member', title: name });
  const { upcoming, recent } = memberProfile(m.memberRef, data, { now });
  const row = ({ cls: c, kind, spot }) => `<li class="tm-li"><span class="tm-mem-gym">${gymSquareChip(c.gymId)}</span>
    <span class="tm-grow tm-min0"><span class="tm-li-title tm-ellip">${escapeHtml(c.className)}</span>
    <span class="tm-li-sub">${escapeHtml(whenLabel(c, now))}${placeOf(c) ? ` · ${escapeHtml(placeOf(c))}` : ''}${spot ? `${escapeHtml(T.spotSep)}${escapeHtml(spot)}` : ''}${kind === 'waitlist' ? ` (${escapeHtml(T.waitlistTag)})` : ''}${kind === 'queued' ? ` (${escapeHtml(T.queuedTag)})` : ''}</span></span></li>`;
  const recentRow = ({ cls: c }) => `<li class="tm-li"><span class="tm-mem-gym">${gymSquareChip(c.gymId)}</span>
    <span class="tm-grow tm-min0"><span class="tm-li-title tm-ellip">${escapeHtml(c.className)}</span>
    <span class="tm-li-sub">${escapeHtml(DateTime.fromISO(String(c.startAt), { setZone: true }).setZone(c.timeZone || deviceZone()).toFormat('ccc d LLL'))} ${escapeHtml(timeOf(c))}${placeOf(c) ? ` · ${escapeHtml(placeOf(c))}` : ''}</span></span></li>`;
  const lines = memberLines(m, memberActivity([m], data.classes, { now }).get(m.memberRef), now);
  page.body.innerHTML = `<div class="tm-row tm-profile-head">${avatarHtml(m, { size: 'lg', label: false })}
      <div class="tm-grow tm-min0"><div class="tm-mem-name"><span class="tm-ellip">${escapeHtml(name)}</span>${m.isCaptain ? captainBadgeHtml() : ''}</div>
      <div class="tm-muted tm-sm">${escapeHtml(lines[0] ? lines[0].text : '')}</div></div></div>
    ${upcoming.length ? `<h2 class="tm-group-title">${escapeHtml(T.profileUpcoming)}</h2><ul class="tm-list tm-plain">${upcoming.map(row).join('')}</ul>` : ''}
    ${recent.length ? `<h2 class="tm-group-title">${escapeHtml(T.profileRecent)}</h2><ul class="tm-list tm-plain">${recent.map(recentRow).join('')}</ul>` : ''}
    ${!upcoming.length && !recent.length ? `<p class="tm-muted tm-mt">${escapeHtml(T.profileNothing)}</p>` : ''}`;
  return page;
}


// ---- Team stats (§5.3 item 6, T-4) ------------------------------------------------------------
// Two tiles (classes this week with the change on last week; the Team streak), then a
// carousel of three charts in the approved order: busiest days, gym mix, busiest times.
// Mobile swipes between them (scroll-snap, dots); desktop lays them side by side
// (styles.css, no swiping). The numbers come from the server's `stats` block
// (server/team-stats.js); the charts only cover classes this viewer could already see.

function streakText(v) {
  if (!v.days) return { big: T.streakNone, sub: T.streakNoneSub };
  const big = v.capped ? fmt(T.streakDaysCapped, { n: v.days }) : (v.days === 1 ? T.streakDay : fmt(T.streakDays, { n: v.days }));
  if (v.capped) return { big, sub: T.streakCappedSub };
  const k = v.since && v.since.kind;
  if (k === 'today') return { big, sub: T.streakToday };
  if (k === 'yesterday') return { big, sub: T.streakYesterday };
  if (k === 'weekday') return { big, sub: fmt(T.streakSinceDay, { day: v.since.label }) };
  if (k === 'date') return { big, sub: fmt(T.streakSinceDate, { day: v.since.label }) };
  return { big, sub: '' };
}

function chartCard(title, meta, body, aria) {
  return `<figure class="tm-chart" role="group" aria-label="${escapeHtml(title)}">
    <figcaption class="tm-chart-title">${escapeHtml(title)}</figcaption>
    <div role="img" aria-label="${escapeHtml(aria)}">${body}</div>
    ${meta ? `<p class="tm-chart-meta">${escapeHtml(meta)}</p>` : ''}
  </figure>`;
}

const emptyChart = () => `<p class="tm-muted tm-sm tm-chart-empty">${escapeHtml(T.statsChartEmpty)}</p>`;

function busiestDaysHtml(charts) {
  const v = busiestDaysView(charts.busiestDays);
  const aria = fmt(T.busiestDaysAria, { list: v.bars.map((b) => `${b.long} ${b.count}`).join(', ') });
  const body = v.total ? `<div class="tm-vbars tm-vbars-days">${v.bars.map((b) => `<span class="tm-vbar${b.isPeak ? ' is-peak' : ''}"><i style="height:${Math.max(b.count ? 6 : 2, Math.round(b.frac * 100))}%"></i><span class="tm-vbar-lab">${escapeHtml(b.label)}</span></span>`).join('')}</div>` : emptyChart();
  const meta = v.total ? `${T.last4Weeks}${v.peakName ? ` · ${fmt(T.teamsDay, { day: v.peakName })}` : ''}` : '';
  return chartCard(T.busiestDays, meta, body, aria);
}

function gymMixHtml(charts) {
  const v = gymMixView(charts.gymMix, (gymId) => {
    const b = gymBrand(gymId, 'half');
    return { name: getGymShortName(gymId) || b.name || '', colour: b.brandBg || '' };
  });
  const safeColour = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\([\d\s.,%]+\)$/i.test(c) ? c : 'var(--text-secondary)');
  const aria = fmt(T.gymMixAria, { list: v.rows.map((r) => `${r.name} ${r.percent}%`).join(', ') });
  const body = v.total ? `<ul class="tm-mix">${v.rows.map((r) => `<li class="tm-mix-row">
      <span class="tm-mem-gym">${gymSquareChip(r.gymId)}</span><span class="tm-mix-name tm-ellip">${escapeHtml(r.name)}</span>
      <span class="tm-mix-track"><i style="width:${Math.max(4, Math.round(r.frac * 100))}%;background:${safeColour(r.colour)}"></i></span>
      <b class="tm-mix-pc">${r.percent}%</b></li>`).join('')}</ul>` : emptyChart();
  return chartCard(T.gymMix, v.total ? `${T.last4Weeks} · ${T.gymMixNote}` : '', body, aria);
}

function busiestTimesHtml(charts) {
  const v = busiestTimesView(charts.busiestTimes);
  const aria = fmt(T.busiestTimesAria, { list: v.bars.filter((b) => b.count).map((b) => `${b.label} ${b.count}`).join(', ') || '0' });
  const body = v.total ? `<div class="tm-vbars tm-vbars-times">${v.bars.map((b) => `<span class="tm-vbar${b.isPeak ? ' is-peak' : ''}"><i style="height:${Math.max(b.count ? 6 : 2, Math.round(b.frac * 100))}%"></i><span class="tm-vbar-lab">${b.tick ? escapeHtml(b.label) : ''}</span></span>`).join('')}</div>` : emptyChart();
  return chartCard(T.busiestTimes, v.total ? T.last4Weeks : '', body, aria);
}

/** @returns {boolean} false when the payload has no stats block (the widget hides). */
export function renderTeamStats(section, data, now) {
  const stats = data && data.stats;
  if (!stats) { section.hidden = true; section.innerHTML = ''; return false; }
  section.hidden = false;
  const wk = weekChange(stats.week);
  const deltaText = wk.tone === 'up' ? fmt(T.statsDeltaUp, { n: wk.delta }) : wk.tone === 'down' ? fmt(T.statsDeltaDown, { n: -wk.delta }) : T.statsDeltaSame;
  const st = streakText(streakView(stats.streak, { now, zone: deviceZone() }));
  const charts = stats.charts || {};
  const slides = [busiestDaysHtml(charts), gymMixHtml(charts), busiestTimesHtml(charts)];
  section.innerHTML = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.teamStats)}</h3><span class="tm-grow"></span><span class="tm-card-meta">${escapeHtml(T.statsWeekMeta)}</span></div>
    <div class="tm-stat-tiles">
      <div class="tm-stat-tile"><span class="tm-stat-big">${wk.thisWeek}</span><span class="tm-stat-label">${escapeHtml(wk.thisWeek === 1 ? T.statsClassWeek : T.statsClassesWeek)}</span>
        <span class="tm-stat-delta is-${wk.tone}">${escapeHtml(deltaText)}</span></div>
      <div class="tm-stat-tile"><span class="tm-stat-big">${escapeHtml(st.big)}</span><span class="tm-stat-label">${escapeHtml(T.streakName)}</span>
        ${st.sub ? `<span class="tm-stat-sub">${escapeHtml(st.sub)}</span>` : ''}</div>
    </div>
    <div class="tm-stats-carousel" tabindex="0" aria-label="${escapeHtml(T.statsChartsAria)}">${slides.map((h, i) => `<div class="tm-stats-slide" aria-label="${escapeHtml(fmt(T.statsChartsPage, { n: i + 1, total: slides.length }))}">${h}</div>`).join('')}</div>
    <div class="tm-dots tm-stats-dots" aria-hidden="true">${slides.map((_, i) => `<i class="${i === 0 ? 'is-on' : ''}"></i>`).join('')}</div>`;
  const car = section.querySelector('.tm-stats-carousel');
  const dots = section.querySelectorAll('.tm-stats-dots i');
  car.addEventListener('scroll', () => {
    const i = Math.round(car.scrollLeft / Math.max(1, car.clientWidth));
    dots.forEach((d, j) => d.classList.toggle('is-on', j === i));
  }, { passive: true });
  return true;
}
