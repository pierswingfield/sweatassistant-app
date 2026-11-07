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
  T, fmt, avatarHtml, avatarStackHtml, gymCircleHtml, gymStackHtml, ICONS, captainBadgeHtml, openTeamsPage,
} from './teams-ui.js';
import {
  sortMembers, paginate, readSortChoice, writeSortChoice, SORT_MODES, MEMBERS_PER_PAGE, relativeTime,
} from './teams-model.js';
import {
  todaysWorkouts, weekDays, visibleWeekRows, classesTogether, memberActivity,
  activityScore, heroState, namesList, ctaKind, memberProfile, statusAt,
} from './teams-dashboard-model.js';
import { safeImageUrl } from './safe-url.js';
import { weekChange, streakView, busiestDaysView, busiestTimesView, gymMixView, goalView } from './teams-stats-model.js';

const SORT_LABEL = { name: 'sortName', activity: 'sortActivity', shuffle: 'sortShuffle' };

function storage() {
  try { return window.localStorage; } catch (_) { return null; }
}

// ---- shared bits ---------------------------------------------------------------------------

function timeOf(c) { return formatInZone(c.startAt, c.timeZone || deviceZone()).timeLabel; }

function timeHtml(c) {
  const f = formatInZone(c.startAt, c.timeZone || deviceZone());
  return `<span>${escapeHtml(f.time)}</span>${f.suffix ? `<small>${escapeHtml(f.suffix)}</small>` : ''}`;
}

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
    const spot = String(a.spot || '');
    return `<span class="tm-attendee">${avatarHtml(m, { size: 'xs', label: false })}<b>${escapeHtml(name)}</b>${spot ? `<span class="tm-spot-pill" title="${escapeHtml(spot)}" aria-label="${escapeHtml(spot)}">${escapeHtml(spot)}</span>` : ''}${a.kind !== 'booked' ? `<span class="tm-attendee-kind">${escapeHtml(a.kind === 'waitlist' ? T.waitlistTag : T.queuedTag)}</span>` : ''}</span>`;
  }).filter(Boolean).join('');
}

function attendeeMembers(c, byRef, kinds = ['booked']) {
  return (c.attendees || []).filter((a) => kinds.includes(a.kind)).map((a) => byRef.get(a.memberRef)).filter(Boolean);
}

// ---- header state (§5.3 item 1) ------------------------------------------------------------

export function heroLines(data, now) {
  const h = heroState(data, { now });
  const count = Math.max(h.inClass.length, h.inProgress);
  const state = count ? `${count} in class now` : '';
  const sub = h.done > 0 ? (h.done === 1 ? T.heroDoneOne : fmt(T.heroDoneOf, { done: h.done })) : '';
  return { state, sub, avatars: h.inClass };

}

// ---- Today's workouts (§5.3 item 2) ----------------------------------------------------------

// Expansion is presentation-only and survives the minute/data repaint.
const expandedWorkouts = new WeakMap();
const weekSelections = new WeakMap();
function workoutRow(c, byRef, now, { open = false } = {}) {
  const completed = statusAt(c, now) !== 'upcoming';
  return `<li class="tm-workout${completed ? ' is-done' : ''}${open ? ' is-expanded' : ''}" data-workout="${escapeHtml(c.key)}">
    <div class="tm-workout-main">
      <span class="tm-workout-gym">${gymSquareChip(c.gymId)}</span>
      <span class="tm-workout-time">${timeHtml(c)}</span>
      <button type="button" class="tm-workout-name" data-workout-action${completed ? ` aria-expanded="${open}"` : ''}>${escapeHtml(c.className)}</button>
      <span class="tm-workout-inst">${escapeHtml(c.instructorName || '')}</span>
      <span class="tm-workout-mark" aria-hidden="true">${completed ? ICONS.check : ICONS.chevron}</span>
    </div>
    <div class="tm-workout-details"${completed && !open ? ' inert' : ''}><div class="tm-workout-details-inner">
      <div class="tm-attendees" tabindex="0" aria-label="Attendees">${attendeesHtml(c, byRef)}</div>
      ${completed ? '<button type="button" class="tm-view-class" data-view-class>View class</button>' : ''}
    </div></div>
  </li>`;
}

function wireWorkouts(section, classes, now, byRef) {
  let expanded = expandedWorkouts.get(section);
  if (!expanded) { expanded = new Set(); expandedWorkouts.set(section, expanded); }
  section.querySelectorAll('[data-workout]').forEach((row) => {
    const c = classes.find((cls) => String(cls.key) === row.dataset.workout);
    const done = row.classList.contains('is-done');
    const activate = () => {
      if (!done) { openTeamClass(c, byRef); return; }
      const open = !row.classList.contains('is-expanded');
      row.classList.toggle('is-expanded', open);
      row.querySelector('[data-workout-action]').setAttribute('aria-expanded', String(open));
      row.querySelector('.tm-workout-details').toggleAttribute('inert', !open);
      if (open) expanded.add(c.key); else expanded.delete(c.key);
    };
    let origin = null;
    let dragged = false;
    row.addEventListener('pointerdown', (e) => { origin = [e.clientX, e.clientY]; dragged = false; }, { passive: true });
    row.addEventListener('pointermove', (e) => { if (origin && Math.hypot(e.clientX - origin[0], e.clientY - origin[1]) > 8) dragged = true; }, { passive: true });
    row.addEventListener('pointercancel', () => { dragged = true; origin = null; });
    row.addEventListener('click', (e) => {
      if (dragged) return;
      const interactive = e.target.closest('button, a, input, select, textarea');
      if (interactive && !interactive.matches('[data-workout-action]')) return;
      activate();
    });
    row.querySelector('[data-view-class]')?.addEventListener('click', () => openTeamClass(c, byRef));
  });
}

function progressRingHtml(fraction, label, aria) {
  const circ = 2 * Math.PI * 20;
  const f = Math.max(0, Math.min(1, fraction));
  return `<span class="tm-pring" role="img" aria-label="${escapeHtml(aria)}"><svg viewBox="0 0 48 48" aria-hidden="true"><circle class="tm-pring-track" cx="24" cy="24" r="20"/><circle class="tm-pring-prog" cx="24" cy="24" r="20" stroke-dasharray="${(f * circ).toFixed(1)} ${circ.toFixed(1)}"/></svg><span>${escapeHtml(label)}</span></span>`;
}

/** A dismissible sheet delegates every booking decision to the timetable model. */
export async function openTeamClass(c, byRef = new Map()) {
  let alive = true;
  let update = null;
  const page = openTeamsPage({ title: c.className, onClose: () => { alive = false; if (update) window.removeEventListener('app-timetable-rendered', update); } });
  page.body.innerHTML = `<div class="tm-loading" role="status">${escapeHtml(T.loading)}</div>`;
  const [tt, bookings] = await Promise.all([import('./timetable.js'), import('./bookings.js')]);
  const paint = () => {
    if (!alive || !page.body.isConnected) return;
    const event = tt.getLoadedEvents().find((e) => String(e.gymId) === String(c.gymId) && String(e.id) === String(c.eventId));
    page.body.innerHTML = '';
    if (event) {
      const action = disabledGym(c.gymId) ? { label: fmt(T.turnOnGym, { gym: getGymShortName(c.gymId) || '' }), run: () => page.closeThen(() => openGymSettings(c.gymId)), variant: 'outline' } : tt.primaryActionForEvent(event);
      const cardHost = document.createElement('div');
      bookings.mountBookingCard(cardHost, { event, eventId: event.id, gymId: event.gymId, bookings: [] });
      cardHost.querySelector('.ab-card-footer')?.remove();
      cardHost.querySelector('.ab-card-rail')?.remove();
      cardHost.className = 'tm-class-card';
      const actions = document.createElement('div'); actions.className = 'tm-class-actions';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tm-btn tm-btn-primary tm-btn-block'; button.textContent = action.label; button.disabled = !!action.disabled || !action.run;
      button.onclick = () => action.run?.(button);
      actions.appendChild(button); cardHost.appendChild(actions); page.body.appendChild(cardHost);
      const alternate = !disabledGym(c.gymId) && tt.actionModelForTeamEvent?.(event)?.alternate;
      if (alternate) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'tm-btn tm-btn-block tm-mt-s'; button.textContent = alternate.label;
        button.onclick = () => alternate.run(button); actions.appendChild(button);
      }
    } else {
      const text = document.createElement('p'); text.className = 'tm-group-help';
      text.textContent = `${timeOf(c)} · ${c.instructorName || ''} · ${placeOf(c)}`;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tm-btn tm-btn-primary tm-btn-block'; button.textContent = T.viewInTimetable;
      button.onclick = () => page.closeThen(() => {
        window.switchTab?.('class-timetable');
        tt.restoreTimetableFromUrl({ day: DateTime.fromISO(c.startAt, { setZone: true }).setZone(c.timeZone || deviceZone()).toISODate(), gyms: [c.gymId] });
      });
      page.body.append(text, button);
    }
    const members = document.createElement('section'); members.className = 'tm-class-members';
    members.innerHTML = `<h2 class="tm-group-title">Team members</h2><div class="tm-list">${(c.attendees || []).map((a) => {
      const member = byRef.get(a.memberRef); if (!member) return '';
      const status = a.kind === 'booked' ? 'Booked' : a.kind === 'waitlist' ? T.waitlistTag : T.queuedTag;
      return `<div class="tm-mrow">${avatarHtml(member, { size: 'md' })}<span class="tm-grow tm-min0"><span class="tm-li-title">${escapeHtml(member.isMe ? T.you : member.name)}</span><span class="tm-li-sub">${escapeHtml(status)}${a.spot ? ` · ${escapeHtml(a.spot)}` : ''}</span></span></div>`;
    }).join('')}</div>`;
    page.body.appendChild(members);
  };
  paint();
  update = () => { if (!page.body.isConnected) { window.removeEventListener('app-timetable-rendered', update); return; } paint(); };
  window.addEventListener('app-timetable-rendered', update);
  tt.ensureScheduleLoaded();
}

/** @returns {boolean} false when there is nothing today. */
export function renderTodaysWorkouts(section, data, now) {
  const rows = todaysWorkouts(data.classes, { now });
  if (!rows.length) { section.hidden = true; section.innerHTML = ''; return false; }
  section.hidden = false;
  const byRef = new Map(data.members.map((m) => [m.memberRef, m]));
  const dateLabel = DateTime.fromMillis(now, { zone: deviceZone() }).toFormat('ccc d LLL');
  const expanded = expandedWorkouts.get(section) || new Set();
  const row = ({ cls: c, status, progress, minutesLeft }) => {
    const done = status === 'done'; const live = status === 'inProgress'; const open = expanded.has(c.key);
    const title = `${escapeHtml(c.className)}${c.instructorName ? ` · ${escapeHtml(c.instructorName)}` : ''}`;
    const lead = done ? gymCircleHtml(c.gymId, { size: 'lg', badge: `<span class="tm-tw-check" aria-hidden="true">${ICONS.check}</span>` }) : live ? progressRingHtml(progress, fmt(T.minLeft, { n: minutesLeft }), fmt(T.minLeftAria, { n: minutesLeft })) : gymCircleHtml(c.gymId, { size: 'lg' });
    return `<li class="tm-tw${done ? ' is-done' : ''}${live ? ' is-live' : ''}${open ? ' is-expanded' : ''}" data-workout="${escapeHtml(c.key)}">
      <span class="tm-tw-lead">${lead}</span><span class="tm-tw-time">${timeHtml(c)}</span>
      <div class="tm-grow tm-min0">${live ? `<span class="tm-tw-kicker"><span class="tm-live-dot" aria-hidden="true"></span>${escapeHtml(T.inClass)} <span class="tm-muted">${escapeHtml(timeOf(c))}–${escapeHtml(endTimeOf(c))}</span></span>` : ''}
        <button type="button" class="tm-tw-title" data-workout-action${done ? ` aria-expanded="${open}"` : ''}>${title}</button>
        <div class="tm-workout-details"${done && !open ? ' inert' : ''}><div class="tm-workout-details-inner"><div class="tm-attendees tm-tw-who" tabindex="0" aria-label="Attendees">${attendeesHtml(c, byRef, { kinds: ['booked'] })}</div>${done ? '<button type="button" class="tm-view-class" data-view-class>View class</button>' : ''}</div></div>
      </div></li>`;
  };
  section.innerHTML = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.todaysWorkouts)}</h3><span class="tm-grow"></span><span class="tm-card-meta">${escapeHtml(dateLabel)}</span></div><ul class="tm-tw-list">${rows.map(row).join('')}</ul>`;
  wireWorkouts(section, rows.map((r) => r.cls), now, byRef);
  return true;
}

// ---- This week (§5.3 item 3) ----------------------------------------------------------------

export function renderThisWeek(section, data, now) {
  const zone = deviceZone();
  const days = weekDays(data.classes, { now, zone });
  const byRef = new Map(data.members.map((m) => [m.memberRef, m]));
  let selected = days.findIndex((d) => d.date === weekSelections.get(section));
  let expanded = false;

  const dayBtn = (d, i) => {
    const dots = d.memberRefs.slice(0, 5).map((r) => byRef.get(r)).filter(Boolean)
      .map((m) => `<i class="tm-av-c${Number(m.colourIndex) || 0}"></i>`).join('');
    const aria = fmt(T.weekDayAria, { day: `${d.isToday ? T.weekToday : d.weekday} ${d.dayNum}`, count: d.classes.length });
    return `<button type="button" class="tm-wday${i === selected ? ' is-on' : ''}${d.classes.length ? ' has-classes' : ''}" data-day="${i}" aria-expanded="${i === selected}" aria-controls="tm-week-classes" aria-label="${escapeHtml(aria)}">
      <span class="tm-wday-name">${escapeHtml(d.weekday)}</span><span class="tm-wday-num">${d.dayNum}</span><span class="tm-wday-dots" aria-hidden="true">${dots}</span></button>`;
  };

  const rowHtml = (c) => workoutRow(c, byRef, now, { open: expandedWorkouts.get(section)?.has(c.key) });

  const paint = () => {
    const d = days[selected];
    const { rows, hidden } = d ? visibleWeekRows(d.classes, expanded) : { rows: [], hidden: 0 };
    section.innerHTML = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.thisWeek)}</h3></div>
      <p class="tm-week-hint"${d ? ' hidden' : ''}>Choose a day to see classes</p>
      <div class="tm-week" role="group" aria-label="${escapeHtml(T.thisWeek)}">${days.map(dayBtn).join('')}</div>
      <div id="tm-week-classes"${!d ? ' hidden' : ''}>${rows.length ? `<ul class="tm-workouts">${rows.map(rowHtml).join('')}</ul>` : d ? `<p class="tm-muted tm-sm tm-week-empty">${escapeHtml(T.noClassesDay)}</p>` : ''}</div>
      ${hidden ? `<button type="button" class="tm-btn tm-btn-block tm-mt-s" data-more>${escapeHtml(fmt(T.seeMore, { count: hidden }))}</button>` : ''}
      ${expanded && d && d.classes.length > 3 ? `<button type="button" class="tm-btn tm-btn-ghost tm-btn-block tm-mt-s" data-less>${escapeHtml(T.seeLess)}</button>` : ''}`;
    wireWorkouts(section, rows, now, byRef);
    section.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      const tapped = Number(b.getAttribute('data-day'));
      selected = selected === tapped ? -1 : tapped;
      if (selected < 0) { weekSelections.delete(section); expandedWorkouts.delete(section); }
      else weekSelections.set(section, days[selected].date);
      expanded = false;
      paint();
      section.querySelector(`[data-day="${tapped}"]`)?.focus();
    }));
    section.querySelector('[data-more]')?.addEventListener('click', () => { expanded = true; paint(); });
    section.querySelector('[data-less]')?.addEventListener('click', () => { expanded = false; paint(); });
    const strip = section.querySelector('.tm-week');
    // Scroll only this horizontal strip; scrollIntoView also moves the page and
    // can hide the Team breadcrumb or jump the page on each minute refresh.
    const selectedDay = strip.querySelector('.is-on');
    if (selectedDay) {
      const left = selectedDay.offsetLeft - strip.offsetLeft;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (left + selectedDay.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + selectedDay.offsetWidth - strip.clientWidth;
    }
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
  // Nothing booked together: the whole section disappears (no empty-state copy).
  if (!list.length) { section.hidden = true; section.innerHTML = ''; return; }
  section.hidden = false;
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
    lines.push({ text: 'In class now', live: true });
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
    const gymNames = (m.gyms || []).map((g) => getGymShortName(g) || '').filter(Boolean).join(', ');
    return `<button type="button" class="tm-mem-card" data-member="${escapeHtml(m.memberRef)}" aria-label="${escapeHtml(fmt(T.openMember, { name: m.isMe ? T.you : m.name }))}">
      ${avatarHtml(m, { size: 'lg', label: false })}
      <span class="tm-grow tm-min0">
        <span class="tm-mem-name"><span class="tm-ellip">${escapeHtml(m.isMe ? T.you : m.name)}</span>${m.isCaptain ? captainBadgeHtml() : ''}</span>
        ${lines.map((l) => `<span class="tm-mem-line${l.live ? ' tm-inclass-pill' : ''}${l.muted ? ' tm-muted' : ''}${l.warn ? ' tm-warn' : ''}">${escapeHtml(l.text)}</span>`).join('')}
      </span>
      <span class="tm-mem-gyms"${gymNames ? ` title="${escapeHtml(gymNames)}"` : ''}>${gymStackHtml(m.gyms, { max: 4 })}</span>
    </button>`;
  };

  const paint = () => {
    const sorted = sortMembers(members, mode, { seed: shuffleSeed, activityOf: activityScore });
    const pages = paginate(sorted, MEMBERS_PER_PAGE);
    section.innerHTML = `
      <div class="tm-card-head">
        <h3 class="tm-card-title">${escapeHtml(T.members)}</h3>
        <span class="tm-card-meta tm-count-pill">${members.length}</span><span class="tm-grow"></span>
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
// carousel: busiest days, gym mix, busiest times and instructor growth.
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

function trendingInstructorsHtml(charts) {
  const rows = Array.isArray(charts.trendingInstructors) ? charts.trendingInstructors : [];
  const peak = Math.max(1, ...rows.map((r) => r.delta));
  const body = rows.length ? `<ol class="tm-trending">${rows.map((r) => `<li class="tm-trending-row">
    <span class="tm-trending-identity" data-instructor-gym="${escapeHtml(r.gymId)}" data-instructor-id="${escapeHtml(r.instructorId || '')}" data-instructor-name="${escapeHtml(r.name)}"><span class="tm-trending-avatar"></span><span class="tm-trending-gym">${gymSquareChip(r.gymId)}</span></span>
    <span class="tm-trending-info"><span class="tm-trending-name">${escapeHtml(r.name)}</span><span class="tm-trending-count">${r.current} shared class visits</span><span class="tm-trending-track"><i style="width:${Math.round(r.delta / peak * 100)}%"></i></span></span><b class="tm-trending-delta">+${r.delta}</b>
  </li>`).join('')}</ol>` : '<p class="tm-muted tm-sm tm-chart-empty">No rising instructors yet. At least two shared class visits and an increase are needed.</p>';
  return chartCard('Trending instructors', '', body, `Last 14 days versus previous 14. ${rows.map((r) => `${r.name}: ${r.current} shared class visits, previously ${r.previous}, up ${r.delta}`).join('; ') || 'No rising instructors yet'}`);
}

function hydrateTrendingPhotos(section) {
  const paint = (instructors = []) => section.querySelectorAll('[data-instructor-gym]').forEach((row) => {
    const matches = instructors.filter((i) => i.gymId === row.dataset.instructorGym && (row.dataset.instructorId ? String(i.id) === row.dataset.instructorId : i.name === row.dataset.instructorName));
    const instructor = matches.length === 1 ? matches[0] : null;
    const host = row.querySelector('.tm-trending-avatar');
    const initials = row.dataset.instructorName.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    const fallback = () => { host.innerHTML = `<span class="tm-av tm-av-sm tm-av-c0" aria-hidden="true">${escapeHtml(initials)}</span>`; };
    fallback();
    const photo = safeImageUrl(instructor?.thumbUrl || instructor?.imageUrl || '');
    if (photo) { const img = document.createElement('img'); img.src = photo; img.alt = ''; img.width = 32; img.height = 32; img.className = 'tm-trending-photo'; img.addEventListener('error', fallback, { once: true }); host.replaceChildren(img); }
  });
  paint();
  // Public normalized metadata is already cached by the app. Only ask for gyms in
  // the server-approved ranking; never load another member's history or credentials.
  Promise.all([import('./timetable.js'), import('../api.js')]).then(async ([{ metadata }, { api }]) => {
    if (!section.isConnected) return;
    paint(metadata.instructors);
    const gyms = [...new Set([...section.querySelectorAll('[data-instructor-gym]')].map((r) => r.dataset.instructorGym))];
    const results = await Promise.allSettled(gyms.map((gymId) => api.getMetadata({ gymId, ttlMs: 300000, loading: false })));
    const instructors = results.flatMap((r) => r.status === 'fulfilled' ? r.value.instructors || [] : []);
    if (section.isConnected) paint(instructors);
  }).catch(() => {});
}

/** @returns {boolean} false when the payload has no stats block (the widget hides). */
/**
 * D13 Team goal (§8.1 option B): "14 of 20 classes this week" and a bar. Cooperative: no
 * names, no ranking. Hidden when no goal is set; a Captain then gets a quiet "Set a Team
 * goal" link instead (`canEdit`), and an Edit link once one is set.
 */
export function teamGoalHtml(goal, { canEdit = false } = {}) {
  const g = goalView(goal);
  if (!g) return '';
  const msg = g.reached ? T.goalMsgDone : g.count === 0 ? T.goalMsgStart : g.remaining === 1 ? T.goalMsgOne : fmt(T.goalMsgGoing, { n: g.remaining });
  const r = 34;
  const circ = 2 * Math.PI * r;
  const ring = `<span class="tm-goal-ring" aria-hidden="true"><svg viewBox="0 0 80 80"><circle class="tm-goal-ring-track" cx="40" cy="40" r="${r}"/><circle class="tm-goal-ring-prog" cx="40" cy="40" r="${r}" stroke-dasharray="${((g.percent / 100) * circ).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 40 40)"/></svg><span class="tm-goal-ring-num"><b>${g.count}</b><i>${escapeHtml(fmt(T.goalRingOf, { target: g.target }))}</i></span></span>`;
  return `<div class="tm-goal${g.reached ? ' is-reached' : ''}" role="group" aria-label="${escapeHtml(fmt(T.goalAria, { count: g.count, target: g.target }))}">
      ${ring}
      <div class="tm-goal-body">
        <div class="tm-goal-head"><span class="tm-goal-name">${escapeHtml(T.goalTitle)}</span><span class="tm-grow"></span>
          ${canEdit ? `<button type="button" class="tm-goal-edit" data-goal-edit aria-label="${escapeHtml(T.goalEditAria)}">${escapeHtml(T.goalEdit)}</button>` : ''}</div>
        <div class="tm-goal-of">${escapeHtml(T.statsClassesWeek)}</div>
        <p class="tm-goal-msg">${escapeHtml(msg)}</p>
      </div>
    </div>`;
}

export function renderTeamStats(section, data, now, { onEditGoal = null } = {}) {
  const stats = data && data.stats;
  if (!stats) { section.hidden = true; section.innerHTML = ''; return false; }
  section.hidden = false;
  const wk = weekChange(stats.week);
  const deltaText = wk.tone === 'up' ? fmt(T.statsDeltaUp, { n: wk.delta }) : wk.tone === 'down' ? fmt(T.statsDeltaDown, { n: -wk.delta }) : T.statsDeltaSame;
  const st = streakText(streakView(stats.streak, { now, zone: deviceZone() }));
  const charts = stats.charts || {};
  const slides = [busiestDaysHtml(charts), gymMixHtml(charts), busiestTimesHtml(charts), trendingInstructorsHtml(charts)];
  const canEditGoal = !!onEditGoal && data.myRole === 'captain';
  // No goal yet: a Captain gets the "Set a weekly Team goal" prompt at the foot of the card.
  const setGoal = !goalView(data.goal) && canEditGoal ? `<button type="button" class="tm-goal-set" data-goal-edit>${escapeHtml(T.goalSet)}</button>` : '';
  section.innerHTML = `<div class="tm-card-head"><h3 class="tm-card-title">${escapeHtml(T.teamStats)}</h3><span class="tm-grow"></span><span class="tm-card-meta">${escapeHtml(T.statsWeekMeta)}</span></div>
    ${teamGoalHtml(data.goal, { canEdit: canEditGoal })}
    <div class="tm-stat-tiles">
      <div class="tm-stat-tile"><span class="tm-stat-big">${wk.thisWeek}</span><span class="tm-stat-label">${escapeHtml(wk.thisWeek === 1 ? T.statsClassWeek : T.statsClassesWeek)}</span>
        <span class="tm-stat-delta is-${wk.tone}">${escapeHtml(deltaText)}</span></div>
      <div class="tm-stat-tile"><span class="tm-stat-big">${escapeHtml(st.big)}</span><span class="tm-stat-label">${escapeHtml(T.streakName)}</span>
</div>
    </div>
    <div class="tm-stats-carousel" tabindex="0" aria-label="${escapeHtml(T.statsChartsAria)}">${slides.map((h, i) => `<div class="tm-stats-slide" aria-label="${escapeHtml(fmt(T.statsChartsPage, { n: i + 1, total: slides.length }))}">${h}</div>`).join('')}</div>
    <div class="tm-dots tm-stats-dots" aria-hidden="true">${slides.map((_, i) => `<i class="${i === 0 ? 'is-on' : ''}"></i>`).join('')}</div>
    ${setGoal}`;
  section.querySelectorAll('[data-goal-edit]').forEach((b) => b.addEventListener('click', () => onEditGoal && onEditGoal()));
  hydrateTrendingPhotos(section);
  const car = section.querySelector('.tm-stats-carousel');
  const dots = section.querySelectorAll('.tm-stats-dots i');
  car.addEventListener('scroll', () => {
    const i = Math.round(car.scrollLeft / Math.max(1, car.clientWidth));
    dots.forEach((d, j) => d.classList.toggle('is-on', j === i));
  }, { passive: true });
  return true;
}
