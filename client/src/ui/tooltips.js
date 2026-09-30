import { api } from '../api';
import { metadata } from './timetable';
import { COPY, formatCopyText } from '../copy.js';

let occupancyHoverTimeout = null;
let occupancyHideTimeout = null;
let activeOccupancyHoverTarget = null;
const eventDetailsCache = new Map();

let hoverTimeout = null;
let hideTimeout = null;
let activeHoverTarget = null;

// F-15: proxy failures deliberately remain private to the app. Do not retry a
// provider URL from the client; swap the failed image for the deterministic
// initial supplied with it instead. Capture phase sees image `error` events.
if (typeof document !== 'undefined') {
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.dataset.instructorInitial || image.dataset.instructorFallbackDone) return;
    // Proxy 503/429 are transient (img error events expose no status): retry
    // the same same-origin URL once after a short delay, then fall back.
    const src = image.getAttribute('src') || '';
    if (src.startsWith('/api/instructor-photo/') && !image.dataset.instructorRetried) {
      image.dataset.instructorRetried = '1';
      setTimeout(() => { if (image.isConnected) image.setAttribute('src', src); }, 3500);
      return;
    }
    image.dataset.instructorFallbackDone = '1';
    const fallback = document.createElement('span');
    fallback.className = `${image.className} instructor-avatar-initial`;
    fallback.textContent = image.dataset.instructorInitial;
    fallback.setAttribute('aria-hidden', 'true');
    image.replaceWith(fallback);
  }, true);
}

// Build the instructor tooltip inner HTML for a given instructor id.
// Returns null if the instructor isn't in metadata yet. Shared by the hover
// (desktop) and tap (touch) code paths.

// Instagram: expect "username" or "@username" → https://instagram.com/username
function parseInstagramHandle(raw) {
  if (!raw) return null;
  const handle = String(raw).trim().replace(/^@/, '');
  return handle || null;
}

// Spotify: values arrive in several shapes — extract the user id and build
// https://open.spotify.com/user/<id>. Examples handled:
//   "pjowsey?si=…"                       → pjowsey
//   "/user/21wetvc4kmvw4ao3h5la663my"    → 21wetvc4kmvw4ao3h5la663my
//   "@21iklhksmh5l6wkvrza7egzuy?si=…"   → 21iklhksmh5l6wkvrza7egzuy
//   "@hazel_leishman"                    → hazel_leishman
function parseSpotifyUserId(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Full path or URL containing /user/<id>
  const userMatch = s.match(/\/user\/([^?\/]+)/);
  if (userMatch) return userMatch[1];
  // Otherwise strip a leading @ and drop any query string
  return s.replace(/^@/, '').split('?')[0] || null;
}

function initialFor(name) {
  const first = String(name || '').trim().charAt(0).toUpperCase();
  return /^[A-Z0-9]$/.test(first) ? first : '?';
}

/**
 * Small instructor avatar for a card row. `directUrl` is the photo already
 * embedded on the booking/event's OWN instructor object when the caller has
 * one (MarianaTek events carry `thumbUrl`/`imageUrl` per instructor directly —
 * see `marianatek.js mapClassToEvent`) — always prefer it, since it's exact
 * and instant. Fall back to a NAME lookup against `metadata.instructors` only
 * when the caller has no such object: Auto-Book/Auto-Upgrade rows carry only
 * `instructor_name` (their DB rows have no photo field), and CodexFit events
 * never carry a per-event photo at all (`codexfit.js mapEventToNormalized`
 * confirmed this 2026-09-02 — only the bulk `/instructors` metadata endpoint
 * has one for Psycle).
 *
 * The fallback used to be the ONLY path for every caller, including ones that
 * had a direct photo sitting right there unused. That's what made JAB photos
 * flicker in My Bookings: `metadata.instructors` for a MarianaTek gym is
 * derived from whatever's currently in its public class-list window
 * (`marianatek.js fetchMetadata`), which does not reliably include every
 * class a user has already booked — so the same instructor would resolve on
 * one page load and silently miss on the next, independent of any image
 * loading/timing. Two lookups for one fact drift; this fixes it by not doing
 * the second lookup when the first fact is already in hand.
 *
 * Gym-scoped on the fallback path only: two gyms can have an instructor with
 * the same name as easily as the same id, and an unscoped match paints the
 * wrong face.
 *
 * `thumbUrl` first: a provider that publishes a small rendering should never
 * have its full-size image pulled for a 26px circle. Falling back to `imageUrl`
 * is a deliberate trade — CodexFit publishes one size only.
 */
export function instructorAvatar(name, gymId = null, directUrl = null, { size = 52, lazy = false, cls = 'ab-card-avatar' } = {}) {
  let url = directUrl || null;
  if (!url) {
    if (!name) return '';
    const wanted = String(name).trim().toLowerCase();
    if (!wanted) return '';
    const list = metadata.instructors || [];
    const match = list.find(i =>
      String(i.name || '').trim().toLowerCase() === wanted &&
      (!gymId || !i.gymId || i.gymId === gymId)
    );
    url = match && (match.thumbUrl || match.imageUrl);
  }
  if (!url) return '';
  // No `loading="lazy"`: these cards can repaint several times in quick
  // succession as data (bookings, then metadata) arrives, and a lazy image
  // whose element gets replaced before the browser schedules its viewport
  // check never starts loading at all — indistinguishable from "missing".
  // `lazy` is opt-in for long stable lists (the timetable); the default stays eager for the reason above.
  return `<img class="${cls}" src="${url}" alt="" aria-hidden="true" data-instructor-initial="${initialFor(name)}" decoding="async"${lazy ? ' loading="lazy"' : ''} width="${size}" height="${size}">`;
}

function instructorTooltipHTML(instructorIdRaw, gymId = null) {
  const instructorId = String(instructorIdRaw);
  // Normalized ids are strings; instructorId comes off a raw event as a number or string.
  // Gym-scoped: two gyms can have an instructor with the same numeric id
  // (found 2026-09-02 — this is what broke Psycle instructor photos/bios once
  // a merged multi-gym timetable made id collisions possible).
  const instructor = metadata.instructors.find(i => String(i.id) === instructorId && (!gymId || i.gymId === gymId));
  if (!instructor) return null;

  const photoUrl = instructor.imageUrl || instructor.photo || instructor.image_1 || '';
  const name = instructor.name || instructor.full_name || 'Instructor';
  const avatarHtml = photoUrl
    ? `<img src="${photoUrl}" class="psycle-tooltip-avatar" alt="${name}" data-instructor-initial="${initialFor(name)}">`
    : `<div class="psycle-tooltip-avatar" style="display:flex; align-items:center; justify-content:center; background:color-mix(in srgb, var(--text) 8%, transparent); font-weight:bold; font-size:16px; color:#fff;">${(name || '?')[0]}</div>`;

  const keywords = instructor.metafields?.keywords ? instructor.metafields.keywords.replace(/\|/g, ' • ') : '';
  const description = instructor.bio || instructor.metafields?.description || '';

  let instagramHtml = '';
  const igRaw = instructor.instagramHandle || instructor.metafields?.instagram_handle || instructor.instagram_handle;
  const igUrl = instructor.instagramUrl;
  const igHandle = parseInstagramHandle(igRaw);
  if (igUrl || igHandle) {
    const href = igUrl || `https://instagram.com/${igHandle}`;
    const label = igHandle ? `@${igHandle}` : COPY.tooltips.instagram;
    instagramHtml = `<a class="psycle-tooltip-social-link" href="${href}" target="_blank" rel="noopener noreferrer">📸 ${label}</a>`;
  }
  let spotifyHtml = '';
  const spRaw = instructor.spotifyUrl || instructor.metafields?.spotify_handle || instructor.spotify_handle;
  const spId = parseSpotifyUserId(spRaw);
  if (spId || instructor.spotifyUrl) {
    const href = instructor.spotifyUrl || `https://open.spotify.com/user/${spId}`;
    const label = spId ? `@${spId}` : COPY.tooltips.spotify;
    spotifyHtml = `<a class="psycle-tooltip-social-link" href="${href}" target="_blank" rel="noopener noreferrer">🎵 ${label}</a>`;
  }

  return `
    <div class="psycle-tooltip-header">
      ${avatarHtml}
      <div style="min-width: 0; flex: 1;">
        <h4 class="psycle-tooltip-name">${name}</h4>
        ${keywords ? `<div class="psycle-tooltip-keywords">${keywords}</div>` : ''}
      </div>
    </div>
    ${description ? `<p style="margin: 6px 0 0 0; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; color: var(--text); font-size: 12px; line-height: 1.4;">${description}</p>` : ''}
    ${(instagramHtml || spotifyHtml) ? `<div class="psycle-tooltip-socials" style="margin-top: 10px;">${instagramHtml}${spotifyHtml}</div>` : ''}
  `;
}

export function initTooltips() {
  const instructorTooltip = document.getElementById('psycle-instructor-tooltip');
  const occupancyTooltip = document.getElementById('psycle-occupancy-tooltip');

  if (!instructorTooltip || !occupancyTooltip) return;

  // Delegated mouse hover listeners for instructor tooltip
  document.body.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.psycle-instructor-hover');
    const tooltip = e.target.closest('#psycle-instructor-tooltip');

    if (tooltip || target) {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
    }

    if (!target) return;

    if (activeHoverTarget === target) return;
    activeHoverTarget = target;

    if (hoverTimeout) clearTimeout(hoverTimeout);

    hoverTimeout = setTimeout(() => {
      const html = instructorTooltipHTML(target.getAttribute('data-id'), target.getAttribute('data-gym-id'));
      if (!html) return;
      instructorTooltip.innerHTML = html;
      instructorTooltip.style.display = 'block';
      positionTooltip(target, instructorTooltip);
      instructorTooltip.offsetHeight;
      instructorTooltip.classList.add('show');
    }, 1000); // 1s delay
  });

  // Tap or click an instructor name/photo to toggle the profile tooltip modal,
  // and tap/click anywhere else to dismiss it.
  const hideInstructor = () => {
    activeHoverTarget = null;
    instructorTooltip.classList.remove('show');
    instructorTooltip.style.display = 'none';
  };
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('.psycle-instructor-hover');
    if (!target) {
      if (instructorTooltip.classList.contains('show') && !e.target.closest('#psycle-instructor-tooltip')) {
        hideInstructor();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (hoverTimeout) {
      clearTimeout(hoverTimeout);
      hoverTimeout = null;
    }
    // Tapping the open instructor again closes it.
    if (activeHoverTarget === target && instructorTooltip.classList.contains('show')) {
      hideInstructor();
      return;
    }
    const html = instructorTooltipHTML(target.getAttribute('data-id'), target.getAttribute('data-gym-id'));
    if (!html) return;
    activeHoverTarget = target;
    instructorTooltip.innerHTML = html;
    instructorTooltip.style.display = 'block';
    positionTooltip(target, instructorTooltip);
    instructorTooltip.offsetHeight;
    instructorTooltip.classList.add('show');
  });

  document.body.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && instructorTooltip.classList.contains('show')) {
      hideInstructor();
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.psycle-instructor-hover[role="button"]')) {
      e.preventDefault();
      e.target.closest('.psycle-instructor-hover').click();
    }
  });

  document.body.addEventListener('mouseout', (e) => {
    const target = e.target.closest('.psycle-instructor-hover');
    const toElement = e.relatedTarget;

    if (toElement && (toElement.closest('.psycle-instructor-hover') || toElement.closest('#psycle-instructor-tooltip'))) {
      return;
    }

    const fromTooltip = e.target.closest('#psycle-instructor-tooltip');
    if (fromTooltip || target) {
      if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
      }
      
      if (hideTimeout) clearTimeout(hideTimeout);
      hideTimeout = setTimeout(() => {
        activeHoverTarget = null;
        instructorTooltip.classList.remove('show');
        instructorTooltip.style.display = 'none';
      }, 200);
    }
  });

  document.body.addEventListener('mousemove', (e) => {
    const target = e.target.closest('.psycle-instructor-hover');
    if (!target) return;
    if (instructorTooltip.classList.contains('show')) {
      positionTooltip(target, instructorTooltip);
    }
  });

  // Delegated mouse hover listeners for occupancy tooltip
  document.body.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.psycle-occupancy-hover');
    const tooltip = e.target.closest('#psycle-occupancy-tooltip');

    if (tooltip || target) {
      if (occupancyHideTimeout) {
        clearTimeout(occupancyHideTimeout);
        occupancyHideTimeout = null;
      }
    }

    if (!target) return;

    if (activeOccupancyHoverTarget === target) return;
    activeOccupancyHoverTarget = target;

    if (occupancyHoverTimeout) clearTimeout(occupancyHoverTimeout);

    occupancyHoverTimeout = setTimeout(async () => {
      const eventId = parseInt(target.getAttribute('data-id'));
      if (isNaN(eventId)) return;
      const eventGymId = target.getAttribute('data-gym-id') || null;
      // Two gyms can both publish an event with the same numeric id — key the
      // cache on both, same reasoning as scheduler.js's eventCache (WP-G).
      const cacheKey = `${eventGymId || ''}:${eventId}`;

      occupancyTooltip.style.display = 'block';
      positionTooltip(target, occupancyTooltip);
      occupancyTooltip.offsetHeight;
      occupancyTooltip.classList.add('show');

      if (eventDetailsCache.has(cacheKey)) {
        renderMinimap(eventDetailsCache.get(cacheKey), occupancyTooltip);
      } else {
        occupancyTooltip.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:center; padding:15px; color:var(--text); font-size:12px;">
            <svg class="psycle-spinner-svg" viewBox="0 0 24 24" style="animation: spin 1s linear infinite; width: 14px; height: 14px; margin-right: 8px; color: var(--feat-autoupgrade); display: inline-block;">
              <circle cx="12" cy="12" r="10" stroke="color-mix(in srgb, var(--text) 15%, transparent)" stroke-width="3" fill="none"></circle>
              <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor"></path>
            </svg>
            <span style="margin-left: 6px;">${COPY.occupancy.loadingLayout}</span>
          </div>
        `;
        positionTooltip(target, occupancyTooltip);

        try {
          const res = await api.getEventDetails(eventId, eventGymId);
          eventDetailsCache.set(cacheKey, res);
          if (activeOccupancyHoverTarget === target) {
            renderMinimap(res, occupancyTooltip);
          }
        } catch (err) {
          console.error('[Timetable] Failed to fetch event slots for minimap:', err);
          if (activeOccupancyHoverTarget === target) {
            occupancyTooltip.innerHTML = `
              <div style="padding: 10px; color: var(--danger); font-size: 12px; text-align: center; font-weight: 500;">
                ${COPY.occupancy.failedLayout}
              </div>
            `;
            positionTooltip(target, occupancyTooltip);
          }
        }
      }
    }, 350); // 350ms delay
  });

  document.body.addEventListener('mouseout', (e) => {
    const target = e.target.closest('.psycle-occupancy-hover');
    const toElement = e.relatedTarget;

    if (toElement && (toElement.closest('.psycle-occupancy-hover') || toElement.closest('#psycle-occupancy-tooltip'))) {
      return;
    }

    const fromTooltip = e.target.closest('#psycle-occupancy-tooltip');
    if (fromTooltip || target) {
      if (occupancyHoverTimeout) {
        clearTimeout(occupancyHoverTimeout);
        occupancyHoverTimeout = null;
      }
      
      if (occupancyHideTimeout) clearTimeout(occupancyHideTimeout);
      occupancyHideTimeout = setTimeout(() => {
        activeOccupancyHoverTarget = null;
        occupancyTooltip.classList.remove('show');
        occupancyTooltip.style.display = 'none';
      }, 200);
    }
  });

  document.body.addEventListener('mousemove', (e) => {
    const target = e.target.closest('.psycle-occupancy-hover');
    if (!target) return;
    if (occupancyTooltip.classList.contains('show')) {
      positionTooltip(target, occupancyTooltip);
    }
  });
}

function positionTooltip(target, tooltipEl) {
  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();
  let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
  let top = rect.top - tooltipRect.height - 10;
  
  if (left < 10) left = 10;
  if (left + tooltipRect.width > window.innerWidth - 10) {
    left = window.innerWidth - tooltipRect.width - 10;
  }
  if (top < 10) {
    top = rect.bottom + 10;
  }
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
}

// === MOBILE TIMETABLE — export renderMinimap (added Jun 2026; delete 'export' to revert) ===
// Takes the normalized event-details payload from api.getEventDetails():
//   { event, slots: NormalizedSlot[], objects: NormalizedLayoutObject[] }
//
// Each slot carries its own `isAvailable`, so there is no separate "available
// ids" list to intersect — that was a CodexFit response quirk (a sibling `slots`
// array of bare ids next to the studio's full layout), and no other platform
// emits it. Raw payloads are still accepted so a stale IndexedDB entry renders
// rather than throwing.
export function renderMinimap(payload, occupancyTooltip) {
  const isNormalized = Array.isArray(payload?.slots) && (payload.slots.length === 0 || typeof payload.slots[0] === 'object');

  let layoutSlots, layoutObjects, availableSlotIds, totalSlots, openSlots;
  if (isNormalized) {
    layoutSlots = payload.slots || [];
    layoutObjects = payload.objects || [];
    availableSlotIds = new Set(layoutSlots.filter((s) => s.isAvailable).map((s) => String(s.id)));
    totalSlots = payload.event?.capacity ?? payload.capacity ?? layoutSlots.length ?? 0;
    openSlots = payload.event?.availableCount ?? payload.availableCount ?? (layoutSlots.length ? availableSlotIds.size : 0);
  } else {
    const eventData = payload.data || payload;
    const studio = payload.relations?.studios?.[0] || eventData.relations?.studios?.[0] || eventData.studio || {};
    layoutSlots = studio?.layout?.slots || [];
    layoutObjects = studio?.layout?.objects || [];
    const availableSlots = payload.slots || eventData.slots || [];
    availableSlotIds = new Set(availableSlots.map((id) => String(id)));
    totalSlots = eventData.capacity || layoutSlots.length || 0;
    openSlots = availableSlots.length;
  }

  const occupiedSlots = Math.max(0, totalSlots - openSlots);

  if (layoutSlots.length === 0) {
    // FCFS or rooms without a spot map layout (recovery, boxing, etc.)
    occupancyTooltip.innerHTML = `
      <div style="font-size: 12px; font-weight: 700; color: var(--text); text-align: center; margin-bottom: 6px;">
        ${COPY.occupancy.class}
      </div>
      <div style="display:flex; justify-content:space-around; background:var(--surface-inset); border-radius:8px; padding:10px 8px; border:1px solid var(--border);">
        <div style="text-align:center;">
          <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase; font-weight:600;">${COPY.occupancy.total}</div>
          <div style="font-size:15px; font-weight:700; color:var(--text);">${totalSlots || 'N/A'}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase; font-weight:600;">${COPY.occupancy.open}</div>
          <div style="font-size:15px; font-weight:700; color:var(--success);">${openSlots}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase; font-weight:600;">${COPY.occupancy.booked}</div>
          <div style="font-size:15px; font-weight:700; color:var(--danger);">${occupiedSlots}</div>
        </div>
      </div>
    `;
    return;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  layoutSlots.forEach(s => {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  });

  const widthRange = maxX - minX || 1;
  const heightRange = maxY - minY || 1;

  let stageHtml = '';
  layoutObjects.forEach(obj => {
    const left = widthRange === 0 ? 50 : ((obj.x - minX) / widthRange) * 80 + 10;
    const top = heightRange === 0 ? 10 : ((obj.y - minY) / heightRange) * 70 + 15;
    stageHtml += `
      <div class="psycle-minimap-stage" style="left: ${left}%; top: ${top}%; transform: translate(-50%, -50%);">
        ${COPY.tooltips.stage}
      </div>
    `;
  });

  let dotsHtml = '';
  layoutSlots.forEach(slot => {
    const isAvailable = availableSlotIds.has(String(slot.id));
    const left = widthRange === 0 ? 50 : ((slot.x - minX) / widthRange) * 80 + 10;
    const top = heightRange === 0 ? 50 : ((slot.y - minY) / heightRange) * 70 + 15;
    const label = slot.label || slot.id;

    dotsHtml += `
      <div class="psycle-minimap-dot ${isAvailable ? 'available' : 'occupied'}" title="${label}" style="left: ${left}%; top: ${top}%;"></div>
    `;
  });

  // Open spots the studio layout has no position for.
  const layoutSlotIds = new Set(layoutSlots.map(s => String(s.id)));
  const unmappedCount = [...availableSlotIds].filter(id => !layoutSlotIds.has(id)).length;
  let extraSlotsHtml = '';
  if (unmappedCount > 0) {
    extraSlotsHtml += `
      <div style="font-size: 12px; color: var(--text-secondary); text-align: center; margin-top: 4px; border-top: 1px solid color-mix(in srgb, var(--text) 6%, transparent); padding-top: 4px;">
        ${formatCopyText(COPY.tooltips.unmappedSpots, { count: unmappedCount })}
      </div>
    `;
  }

  occupancyTooltip.innerHTML = `
    <div style="font-size: 12px; font-weight: 700; color: var(--text); text-align: center; margin-bottom: 4px;">
      ${COPY.occupancy.studio}
    </div>
    <div style="font-size: 12px; color: var(--text-secondary); display: flex; justify-content: space-between; margin-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent); padding-bottom: 4px;">
      <span>Total: ${totalSlots || 'N/A'}</span>
      <span style="color:var(--success);">Open: ${openSlots}</span>
      <span style="color:var(--danger);">Booked: ${occupiedSlots}</span>
    </div>
    <div class="psycle-minimap-container">
      ${stageHtml}
      ${dotsHtml}
    </div>
    ${extraSlotsHtml}
    <div class="psycle-minimap-legend">
      <div class="psycle-minimap-legend-item">
        <div class="psycle-minimap-legend-dot available"></div>
        <span>${COPY.occupancy.available}</span>
      </div>
      <div class="psycle-minimap-legend-item">
        <div class="psycle-minimap-legend-dot occupied"></div>
        <span>${COPY.occupancy.booked}</span>
      </div>
    </div>
  `;
}
