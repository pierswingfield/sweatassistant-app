// U1-6 — the "this auto-book overlaps something" confirmation.
//
// Flow (see saveAutoBookPreferences in timetable.js):
//   1. POST /api/auto-book. If the class clashes with another queued class or an
//      existing booking, in ANY gym, the server refuses with 409
//      OVERLAP_CONFIRM_REQUIRED and inserts nothing. The rule lives in
//      server/competing-bookings.js and is not re-derived here.
//   2. This modal shows the new class and the class(es) it clashes with, as the
//      app's standard cards.
//   3. "Auto-book anyway" resolves true and the caller resubmits with
//      `confirmOverlap: true`; "Cancel" (button, Esc, backdrop, ×) resolves false
//      and nothing was ever queued.
//
// Modal pattern: the `.psycle-modal` / `-overlay` / `-card` / `-header` / `-body`
// shell used by every dialog in index.html, built on demand because it carries
// per-call content. There is no shared modal component yet (U2-1) and this does
// not build one; it only does the accessibility work such a component would.

import { noSept, zoneFor, formatInZone } from '../lib';
import { icon, disciplineTag, getDiscipline, renderGymRail, cleanClassName, trimLocation, escapeHtml, equalizeDiscTagWidths } from './cards.js';
import { instructorAvatar } from './tooltips.js';
import { getGymShortName, getDefaultGymId } from '../gym-context.js';
import { COPY, formatCopyText } from '../copy.js';
import { pushLayer } from './modal-nav.js';

const MAX_CLASHES_SHOWN = 3;

/**
 * What to say, derived only from the server's warning codes.
 * @param {Array<{code:string, with?:object}>} warnings
 */
/**
 * `mode` is the action being confirmed: 'autobook' (U1-6, default), or 'book' /
 * 'quickbook' (U1-12). The overlap facts come from the server's warnings either
 * way; only the wording of the action changes.
 */
export const OVERLAP_MODES = {
  autobook: { newLabel: COPY.overlap.newAutobook, confirm: COPY.overlap.autoBookAnyway, tail: COPY.overlap.autoBookTail, already: COPY.overlap.alreadyBookedAutoBook },
  book: { newLabel: COPY.overlap.newBooking, confirm: COPY.overlap.bookAnyway, tail: COPY.overlap.bothCanBookTail, already: COPY.overlap.alreadyBooked },
  quickbook: { newLabel: COPY.overlap.newBooking, confirm: COPY.overlap.quickBookAnyway, tail: COPY.overlap.bothCanBookTail, already: COPY.overlap.alreadyBooked },
};

export function describeOverlap(warnings = [], mode = 'autobook') {
  const M = OVERLAP_MODES[mode] || OVERLAP_MODES.autobook;
  const list = (warnings || []).filter((w) => w && w.code !== 'DUPLICATE_QUEUED');
  const hasBooked = list.some((w) => w.code === 'OVERLAP_BOOKED');
  const hasQueued = list.some((w) => w.code === 'OVERLAP_QUEUED');
  const onlyAlready = list.length > 0 && list.every((w) => w.code === 'ALREADY_BOOKED');

  let title;
  let lead;
  if (onlyAlready) {
    title = COPY.overlap.alreadyBookedTitle;
    lead = M.already;
  } else {
    title = COPY.overlap.overlappingTitle;
    const parts = [];
    if (hasBooked || list.some((w) => w.code === 'ALREADY_BOOKED')) parts.push(COPY.overlap.bookedClass);
    if (hasQueued) parts.push(COPY.overlap.queuedClass);
    lead = `${COPY.overlap.overlapsPrefix}${parts.join(' and ') || COPY.overlap.anotherClass}. ${M.tail}`;
  }

  const clashes = list.map((w) => ({
    ...(w.with || {}),
    tag: w.code === 'OVERLAP_QUEUED' ? COPY.overlap.inQueue : COPY.overlap.booked,
    crossGym: !!w.crossGym,
  }));
  return {
    title,
    lead,
    newLabel: M.newLabel,
    confirmLabel: M.confirm,
    clashes: clashes.slice(0, MAX_CLASHES_SHOWN),
    hiddenCount: Math.max(0, clashes.length - MAX_CLASHES_SHOWN),
  };
}

/**
 * One class as the standard card (same markup and classes as an Auto-Book queue
 * card: gym rail, date/time/instructor line, discipline tag + name + location,
 * instructor photo), minus the action rail. `tag` fills the footer pill.
 */
export function classSummaryCardHtml(item, tag) {
  const gymId = item.gymId || getDefaultGymId();
  const fmt = item.startAt ? formatInZone(item.startAt, zoneFor(item, gymId)) : null;
  const valid = !!(fmt && fmt.time);
  const dateStr = valid ? noSept(fmt.date).toUpperCase() : '';
  const timeStr = valid ? fmt.timeLabel : '';
  // Strip by the discipline's display label, not the raw group string: a gym whose
  // `discipline` is the whole class type ("TRAIN - Full Body Conditioning") would
  // otherwise leave the redundant prefix in beside the discipline pill.
  const disc = getDiscipline(item.groupName || item.className).label;
  const name = cleanClassName(item.className || '', disc) || item.groupName || COPY.overlap.class;
  const locationLine = [item.studioName, trimLocation(item.locationName || '', getGymShortName(gymId))].filter(Boolean).join(', ');
  const instructor = item.instructorName || '';
  const avatar = instructorAvatar(instructor, gymId, item.instructorImageUrl || null);

  return `
    <div class="psycle-autobook-card ab-card psycle-overlap-card" data-gym="${escapeHtml(gymId)}">
      ${renderGymRail(gymId)}
      <div class="ab-card-main">
        <div class="ab-card-body">
          <div class="ab-card-lines">
            <div class="ab-card-line1">
              ${dateStr ? `<span class="ab-card-date">${escapeHtml(dateStr)}</span>` : ''}
              ${timeStr ? `<span class="ab-card-time">${escapeHtml(timeStr)}</span>` : ''}
              ${instructor ? `<span class="ab-card-instructor">${escapeHtml(instructor)}</span>` : ''}
            </div>
            <div class="ab-card-line2">
              ${disciplineTag(item.groupName || item.className)}
              <span class="ab-card-class">${escapeHtml(name)}</span>
              ${locationLine ? `<span class="ab-meta-dot">·</span><span class="ab-card-location">${escapeHtml(locationLine)}</span>` : ''}
            </div>
          </div>
          ${avatar ? `<div class="ab-card-figure">${avatar}</div>` : ''}
        </div>
        ${tag ? `<div class="ab-card-footer"><span class="ab-spots-pill">${escapeHtml(tag)}</span></div>` : ''}
      </div>
    </div>`;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Open the confirmation. Resolves true for the confirm button ("Auto-book anyway" / "Book anyway"), false for every
 * way of backing out. Focus moves into the dialog (on Cancel: the safe choice),
 * is trapped there, and returns to whatever had it when the dialog closes.
 *
 * @param {{subject: object, warnings: Array}} args  `subject` is the class being
 *   queued in the same shape as a warning's `with`.
 * @returns {Promise<boolean>}
 */
let pending = null;
export function confirmOverlap({ subject, warnings, mode = 'autobook' }) {
  // One at a time: a double-tap on "Schedule" can produce two refusals, and two
  // stacked dialogs would leave the second one's Esc/focus handling shadowed.
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const info = describeOverlap(warnings, mode);
    const opener = document.activeElement;
    const uid = `psycle-overlap-${Date.now()}`;

    const root = document.createElement('div');
    root.className = 'psycle-modal psycle-overlap-modal';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', `${uid}-title`);
    root.setAttribute('aria-describedby', `${uid}-lead`);
    root.style.display = 'flex';
    root.innerHTML = `
      <div class="psycle-modal-overlay" data-overlap-dismiss></div>
      <div class="psycle-modal-card">
        <div class="psycle-modal-header">
          <h4 id="${uid}-title">${escapeHtml(info.title)}</h4>
          <button type="button" class="psycle-modal-close-btn" data-overlap-cancel aria-label="${COPY.overlap.cancel}">&times;</button>
        </div>
        <div class="psycle-modal-body">
          <div class="ab-credit-warning ab-clash-warning" id="${uid}-lead">${icon('warning', 14)}<span>${escapeHtml(info.lead)}</span></div>
          <div class="psycle-overlap-group" role="group" aria-label="${escapeHtml(info.newLabel)}">
            <p class="psycle-overlap-label">${escapeHtml(info.newLabel)}</p>
          ${classSummaryCardHtml(subject, COPY.overlap.new)}
          </div>
          <div class="psycle-overlap-group" role="group" aria-label="${COPY.overlap.clashesWith}">
            <p class="psycle-overlap-label">${COPY.overlap.clashesWith}</p>
            <div class="psycle-overlap-stack">
              ${info.clashes.map((c) => classSummaryCardHtml(c, c.tag)).join('')}
              ${info.hiddenCount ? `<p class="psycle-overlap-more">${formatCopyText(COPY.overlap.more, { count: info.hiddenCount })}</p>` : ''}
            </div>
          </div>
          <div class="psycle-overlap-actions">
            <button type="button" class="psycle-btn" data-overlap-cancel>${COPY.overlap.cancel}</button>
            <button type="button" class="psycle-btn primary" data-overlap-confirm>${escapeHtml(info.confirmLabel)}</button>
          </div>
        </div>
      </div>`;

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      layer.release(); // mobile: pop our history entry (no-op if back already did)
      document.removeEventListener('keydown', onKeydown, true);
      pending = null;
      root.classList.remove('show');
      setTimeout(() => root.remove(), 250);
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      resolve(result);
    };

    function onKeydown(e) {
      if (e.key === 'Escape') {
        // Capture phase + stop: the auto-book config modal underneath must not
        // also see this Esc and close itself.
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(root.querySelectorAll(FOCUSABLE));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }

    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-overlap-confirm]')) finish(true);
      else if (e.target.closest('[data-overlap-cancel]') || e.target.closest('[data-overlap-dismiss]')) finish(false);
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(root);
    // Mobile: hardware/iOS back cancels this dialog only, not the page beneath it.
    const layer = pushLayer({ id: uid, onBack: () => finish(false) });
    equalizeDiscTagWidths(root);
    // Next frame so the opacity transition runs; focus straight away so a screen
    // reader announces the dialog rather than the page behind it.
    requestAnimationFrame(() => root.classList.add('show'));
    const cancel = root.querySelector('.psycle-overlap-actions [data-overlap-cancel]');
    if (cancel) cancel.focus();
  });
  return pending;
}
