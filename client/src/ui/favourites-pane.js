// F-12: Settings > Favourites. Every favourite across all linked gyms, grouped by weekday (Monday first),
// each shown as the NEXT upcoming timetable class at that gym + studio + weekday + start time. Rows are the
// timetable's own rows (renderEventRowsInto), so this pane has no second copy of row markup, and it makes no
// network calls of its own: favourites come from cache.favouritesByGym, classes from the loaded schedule.
import { cache } from '../main';
import { COPY, formatCopyText } from '../copy.js';
import { getLinkedGyms } from '../gym-context.js';
import { heartButtonHtml } from '../favourite-heart.js';
import { gymChip, disciplineTag, escapeHtml } from './cards.js';
import { renderTimetableSkeleton } from './loading-skeleton.js';
import { getLoadedEvents, isScheduleLoading, ensureScheduleLoaded, renderEventRowsInto, removeFavouriteSlot } from './timetable.js';
import { buildFavouriteGroups, paneState } from './favourites-pane-model.js';

const PANE_ID = 'psycle-settings-pane-favourites';
const HOST_ID = 'psycle-favourites-section';
let lastScheduleAsk = 0;
const isMobileWidth = () => !!window.matchMedia?.('(max-width: 768px)').matches;
const timeLabel = (hhmm) => `${String(hhmm).slice(0, 2)}:${String(hhmm).slice(2, 4)}`;

const TABLE_HEAD = () => `<thead><tr>
  <th style="width: 7%;">${COPY.timetable.timeColumn}</th>
  <th style="width: 8%;">${COPY.timetable.gymColumn}</th>
  <th style="width: 27%;">${COPY.timetable.classColumn}</th>
  <th style="width: 12%;">${COPY.timetable.instructorColumn}</th>
  <th style="width: 15%;">${COPY.timetable.locationStudioColumn}</th>
  <th style="width: 11%;">${COPY.timetable.statusColumn}</th>
  <th style="width: 20%; text-align: right;">${COPY.timetable.actionsColumn}</th>
</tr></thead>`;

/** A favourite whose slot has no upcoming class in the loaded schedule: still listed, from its stored labels. */
function missingRow(item, dayLabel, scheduleLoading) {
  const { fav, gymId } = item;
  const slotLabel = `${dayLabel} ${timeLabel(fav.startTime)}`;
  const title = fav.className || fav.studioName || COPY.common.classFallback;
  const where = [fav.studioName && fav.studioName !== title ? fav.studioName : '', fav.locationName].filter(Boolean).join(' · ');
  const tr = document.createElement('tr');
  tr.className = 'psycle-table-row psycle-fav-missing-row';
  tr.setAttribute('data-gym', gymId);
  tr.innerHTML = `<td colspan="${isMobileWidth() ? 6 : 7}"><div class="psycle-fav-missing">
    <strong class="psycle-fav-missing-time">${escapeHtml(timeLabel(fav.startTime))}</strong>
    ${gymChip(gymId)}
    <div class="psycle-fav-missing-body">
      <div class="psycle-fav-missing-title">${fav.discipline ? disciplineTag(fav.discipline) : ''}<span>${escapeHtml(title)}</span></div>
      ${where ? `<div class="psycle-fav-missing-where">${escapeHtml(where)}</div>` : ''}
      <div class="psycle-fav-missing-note">${escapeHtml(scheduleLoading ? COPY.favouritesPane.checkingSchedule : COPY.favouritesPane.noUpcoming)}</div>
    </div>
    ${heartButtonHtml({ isFavourite: true, eventId: fav.id, label: formatCopyText(COPY.favouritesPane.unfavouriteAria, { slot: slotLabel }), pressedLabel: formatCopyText(COPY.favouritesPane.unfavouriteAria, { slot: slotLabel }), extraClass: 'psycle-fav-missing-heart' })}
  </div></td>`;
  const heart = tr.querySelector('.psycle-timetable-heart');
  heart.dataset.favGym = gymId;
  heart.dataset.favId = fav.id;
  return tr;
}

function buildModel() {
  const gymIds = (getLinkedGyms() || []).map((g) => g.gym_id || g.id).filter(Boolean);
  const model = buildFavouriteGroups({ favouritesByGym: cache.favouritesByGym || {}, gymIds, events: getLoadedEvents(), now: new Date() });
  return { ...model, gymIds, state: paneState({ gymIds, loadedGyms: model.loadedGyms, total: model.total }) };
}

/** Paint the pane into `host` (default: the pane's own host). Safe to call any number of times. */
export function renderFavouritesPane(host = document.getElementById(HOST_ID)) {
  if (!host) return;
  const model = buildModel();
  if (model.state === 'loading') {
    host.innerHTML = `<div role="status" aria-label="${escapeHtml(COPY.favouritesPane.loadingFavourites)}">${renderTimetableSkeleton(4)}</div>`;
    return;
  }
  if (model.state === 'empty') {
    host.innerHTML = `<div class="psycle-empty-state psycle-fav-empty"><p class="psycle-fav-empty-title">${COPY.favouritesPane.emptyTitle}</p><p class="psycle-fav-empty-help">${COPY.favouritesPane.emptyHelp}</p></div>`;
    return;
  }
  // Ask for the schedule at most once a minute (a failed fetch must not loop through the repaint event).
  let asked = false;
  if (!getLoadedEvents().length && Date.now() - lastScheduleAsk > 60000) { lastScheduleAsk = Date.now(); asked = true; ensureScheduleLoaded(); }
  const loading = asked || isScheduleLoading();
  host.innerHTML = `<p class="psycle-fav-note" role="note">${COPY.favouritesPane.note}</p><div class="psycle-fav-days"></div>`;
  const days = host.querySelector('.psycle-fav-days');
  for (const group of model.groups) {
    const section = document.createElement('section');
    section.className = 'psycle-fav-day';
    section.setAttribute('aria-label', formatCopyText(COPY.favouritesPane.dayListLabel, { day: group.label }));
    section.innerHTML = `<h4 class="psycle-fav-day-title">${escapeHtml(group.label)}</h4>
      <div class="psycle-table-container"><table class="psycle-table psycle-fav-table" style="width: 100%; border-collapse: collapse; text-align: left; table-layout: fixed;">${TABLE_HEAD()}<tbody></tbody></table></div>`;
    const tbody = section.querySelector('tbody');
    for (const item of group.items) {
      if (item.event) renderEventRowsInto(tbody, [item.event]);
      else tbody.appendChild(missingRow(item, group.label, loading));
    }
    days.appendChild(section);
  }
}

let wired = false;
/** Bind once: repaint while the pane is showing whenever favourites or the loaded schedule change. */
export function initFavouritesPane() {
  if (wired) return;
  wired = true;
  let timer = 0;
  const repaint = () => {
    if (!document.getElementById(PANE_ID)?.classList.contains('active')) return;
    clearTimeout(timer); // coalesce a burst (favourites + schedule events) into one paint
    timer = setTimeout(() => renderFavouritesPane(), 0);
  };
  window.addEventListener('sweat-favourites-changed', repaint);
  window.addEventListener('sweat-timetable-rendered', repaint);
  document.getElementById(HOST_ID)?.addEventListener('click', (e) => {
    const btn = e.target.closest('.psycle-fav-missing-heart');
    if (!btn) return;
    e.stopPropagation();
    const gymId = btn.dataset.favGym;
    const fav = (cache.favouritesByGym?.[gymId]?.items || []).find((f) => f.id === btn.dataset.favId);
    if (!fav) return;
    btn.classList.add('loading');
    removeFavouriteSlot(gymId, fav, { className: fav.className }).finally(() => btn.classList.remove('loading'));
  });
}
