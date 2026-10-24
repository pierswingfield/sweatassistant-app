import { COPY } from '../copy.js';

function skeletonLine(width, extraClass = '') {
  return `<span class="app-skeleton-line ${extraClass}" style="--skeleton-width:${width}" aria-hidden="true"></span>`;
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function renderCardSkeletons(count = 2, label = COPY.accessibility.loadingCards) {
  const cards = Array.from({ length: count }, (_, index) => `
    <div class="app-skeleton-card" aria-hidden="true" data-skeleton-index="${index}">
      <div class="app-skeleton-card-head">
        ${skeletonLine(index % 2 ? '42%' : '34%', 'is-strong')}
        ${skeletonLine('18%', 'is-chip')}
      </div>
      ${skeletonLine(index % 2 ? '72%' : '64%')}
      ${skeletonLine(index % 2 ? '48%' : '56%', 'is-short')}
    </div>
  `).join('');

  return `<div class="app-skeleton-list" role="status" aria-label="${escapeAttribute(label)}">${cards}</div>`;
}

export function renderTimetableSkeleton(count = 6) {
  const rows = Array.from({ length: count }, (_, index) => `
    <div class="app-skeleton-table-row" aria-hidden="true" data-skeleton-index="${index}">
      ${skeletonLine('58px', 'is-time')}
      ${skeletonLine('54px', 'is-chip')}
      ${skeletonLine(index % 2 ? '170px' : '205px', 'is-class')}
      ${skeletonLine(index % 2 ? '90px' : '112px', 'is-instructor')}
      ${skeletonLine(index % 2 ? '150px' : '180px', 'is-location')}
      ${skeletonLine('82px', 'is-action')}
    </div>
  `).join('');

  return `<div class="app-skeleton-table" role="status" aria-label="${COPY.timetable.loadingTimetable}">${rows}</div>`;
}

// CSSv2: floor-plan placeholder (a stage bar over staggered rows of rounded seats). Replaces the spinner
// everywhere a studio layout loads. Static under prefers-reduced-motion (see styles.css).
export function renderFloorPlanSkeleton(label = COPY.timetable.loadingFloorMap, rows = 5) {
  const counts = [4, 5, 6, 5, 4, 6, 5];
  const seatRows = Array.from({ length: rows }, (_, r) => {
    const n = counts[r % counts.length];
    const seats = Array.from({ length: n }, () => '<span class="app-skeleton-seat"></span>').join('');
    return `<div class="app-skeleton-seat-row" style="--sk-r:${r}">${seats}</div>`;
  }).join('');
  return `<div class="app-skeleton-floor" role="status" aria-label="${escapeAttribute(label)}">
    <span class="app-skeleton-stage" aria-hidden="true"></span>
    <div class="app-skeleton-seats" aria-hidden="true">${seatRows}</div>
  </div>`;
}

// CSSv2: generic text-panel placeholder (modal body or card waiting on a fetch).
export function renderPanelSkeleton(label, lines = 4) {
  const widths = ['62%', '88%', '74%', '46%', '80%', '58%'];
  const body = Array.from({ length: lines }, (_, i) => skeletonLine(widths[i % widths.length], i === 0 ? 'is-strong' : '')).join('');
  return `<div class="app-skeleton-panel" role="status" aria-label="${escapeAttribute(label)}">${body}</div>`;
}
