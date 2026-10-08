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
