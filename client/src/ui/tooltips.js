import { api } from '../api';
import { metadata, mobileRotationForStudio, frontForStudio } from './timetable';
import { makeDisplayRotator, makeUniformFit, effectiveRotation, displayFrontSide, makeFrontBar, FRONT_BAR_PX } from './spot-rotation.js';
import { COPY, formatCopyText } from '../copy.js';
import { renderFloorPlanSkeleton } from './loading-skeleton.js';

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
      // Distinct URL: re-assigning an identical src is not reliably a re-fetch on iOS WebKit.
      setTimeout(() => { if (image.isConnected) image.setAttribute('src', `${src}${src.includes('?') ? '&' : '?'}r=1`); }, 3500);
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

const INSTAGRAM_ICON = '<svg class="ab-ico tip-instagram-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="0.6" fill="currentColor"/></svg>';

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
// URLs that have already loaded once this session. A re-render replaces the <img> elements, and a fresh element
// with async decode / lazy loading paints blank for a frame even from the HTTP cache — the flash seen when
// returning to the timetable. Known-loaded URLs are emitted eager + synchronous so they paint in the same frame.
const loadedAvatarUrls = new Set();
if (typeof document !== 'undefined') {
  document.addEventListener('load', (e) => {
    const el = e.target;
    if (el && el.tagName === 'IMG' && el.hasAttribute('data-instructor-initial') && el.currentSrc) loadedAvatarUrls.add(el.getAttribute('src'));
  }, true);
}

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
  const warm = loadedAvatarUrls.has(url);
  return `<img class="${cls}" src="${url}" alt="" aria-hidden="true" data-instructor-initial="${initialFor(name)}" decoding="${warm ? 'sync' : 'async'}"${lazy && !warm ? ' loading="lazy"' : ''} width="${size}" height="${size}">`;
}

const attrEsc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * data-* attributes for a `.app-instructor-hover` element, taken from the event's OWN
 * instructors[0]. The popup looks the instructor up in `metadata.instructors` first, but for
 * MarianaTek gyms that list is derived from the current class window and can miss the
 * instructor (or the id), so name + photo travel on the element as the fallback.
 */
export function instructorHoverAttrs(instr, gymId = '', fallbackName = '') {
  const name = (instr && instr.name) || fallbackName || '';
  const photo = (instr && (instr.imageUrl || instr.thumbUrl)) || '';
  return `data-id="${attrEsc(instr?.id ?? '')}" data-gym-id="${attrEsc(gymId || '')}" data-name="${attrEsc(name)}" data-photo="${attrEsc(photo)}"`;
}

export function instructorTooltipHTML(instructorIdRaw, gymId = null, fallback = null) {
  const instructorId = String(instructorIdRaw);
  // Normalized ids are strings; instructorId comes off a raw event as a number or string.
  // Gym-scoped: two gyms can have an instructor with the same numeric id
  // (found 2026-09-02 — this is what broke Psycle instructor photos/bios once
  // a merged multi-gym timetable made id collisions possible).
  const list = metadata.instructors || [];
  const wantedName = String(fallback?.name || '').trim().toLowerCase();
  let instructor = (instructorIdRaw !== undefined && instructorIdRaw !== null && instructorIdRaw !== '' && instructorId !== 'undefined')
    ? list.find(i => String(i.id) === instructorId && (!gymId || !i.gymId || i.gymId === gymId))
    : null;
  if (!instructor && wantedName) {
    instructor = list.find(i => String(i.name || i.full_name || '').trim().toLowerCase() === wantedName && (!gymId || !i.gymId || i.gymId === gymId));
  }
  if (!instructor && fallback?.name) {
    // Metadata lacks them: build the popup from the event's own instructor data (no bio).
    instructor = { name: fallback.name, imageUrl: fallback.photo || '' };
  }
  if (!instructor) return null;

  const photoUrl = instructor.imageUrl || instructor.photo || instructor.image_1 || '';
  const name = instructor.name || instructor.full_name || 'Instructor';
  const avatarHtml = photoUrl
    ? `<img src="${photoUrl}" class="app-tooltip-avatar" alt="${name}" data-instructor-initial="${initialFor(name)}">`
    : `<div class="app-tooltip-avatar tip-avatar-box">${(name || '?')[0]}</div>`;

  const keywords = instructor.metafields?.keywords ? instructor.metafields.keywords.replace(/\|/g, ' • ') : '';
  const description = instructor.bio || instructor.metafields?.description || '';

  let instagramHtml = '';
  const igRaw = instructor.instagramHandle || instructor.metafields?.instagram_handle || instructor.instagram_handle;
  const igUrl = instructor.instagramUrl;
  const igHandle = parseInstagramHandle(igRaw);
  if (igUrl || igHandle) {
    const href = igUrl || `https://instagram.com/${igHandle}`;
    const label = igHandle || COPY.tooltips.instagram;
    instagramHtml = `<a class="app-tooltip-social-link" href="${href}" target="_blank" rel="noopener noreferrer">${INSTAGRAM_ICON}<span class="app-tooltip-social-text app-tooltip-social-wrap">${label}</span></a>`;
  }
  let spotifyHtml = '';
  const spRaw = instructor.spotifyUrl || instructor.metafields?.spotify_handle || instructor.spotify_handle;
  const spId = parseSpotifyUserId(spRaw);
  if (spId || instructor.spotifyUrl) {
    const href = instructor.spotifyUrl || `https://open.spotify.com/user/${spId}`;
    const label = spId || COPY.tooltips.spotify;
    spotifyHtml = `<a class="app-tooltip-social-link" href="${href}" target="_blank" rel="noopener noreferrer">🎵 <span class="app-tooltip-social-text">${label}</span></a>`;
  }

  return `
    <div class="app-tooltip-header">
      ${avatarHtml}
      <div class="tip-content-box">
        <h4 class="app-tooltip-name">${name}</h4>
        ${keywords ? `<div class="app-tooltip-keywords">${keywords}</div>` : ''}
      </div>
    </div>
    ${description ? `<p class="tip-description-text">${description}</p>` : ''}
    ${(instagramHtml || spotifyHtml) ? `<div class="app-tooltip-socials tip-socials-container">${instagramHtml}${spotifyHtml}</div>` : ''}
  `;
}

function targetFallback(target) {
  const name = target.getAttribute('data-name');
  return name ? { name, photo: target.getAttribute('data-photo') || '' } : null;
}

export function initTooltips() {
  const instructorTooltip = document.getElementById('app-instructor-tooltip');
  // Scrolling the page dismisses the instructor popup, but only past a small threshold so
  // accidental micro-movement doesn't close it. Capture phase: scroll doesn't bubble.
  let scrollBase = null;
  document.addEventListener('scroll', (e) => {
    if (!instructorTooltip || !instructorTooltip.classList.contains('show')) { scrollBase = null; return; }
    const el = e.target === document ? document.scrollingElement : e.target;
    if (!el || (instructorTooltip.contains && instructorTooltip.contains(el))) return;
    const top = el.scrollTop || 0;
    if (!scrollBase || scrollBase.el !== el) { scrollBase = { el, top }; return; }
    if (Math.abs(top - scrollBase.top) >= 10) { scrollBase = null; hideInstructor(); }
  }, true);
  const occupancyTooltip = document.getElementById('app-occupancy-tooltip');

  if (!instructorTooltip || !occupancyTooltip) return;

  // Delegated mouse hover listeners for instructor tooltip
  document.body.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.app-instructor-hover');
    const tooltip = e.target.closest('#app-instructor-tooltip');

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
      const html = instructorTooltipHTML(target.getAttribute('data-id'), target.getAttribute('data-gym-id'), targetFallback(target));
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
    const target = e.target.closest('.app-instructor-hover');
    if (!target) {
      if (instructorTooltip.classList.contains('show') && !e.target.closest('#app-instructor-tooltip')) {
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
    const html = instructorTooltipHTML(target.getAttribute('data-id'), target.getAttribute('data-gym-id'), targetFallback(target));
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
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.app-instructor-hover[role="button"]')) {
      e.preventDefault();
      e.target.closest('.app-instructor-hover').click();
    }
  });

  document.body.addEventListener('mouseout', (e) => {
    const target = e.target.closest('.app-instructor-hover');
    const toElement = e.relatedTarget;

    if (toElement && (toElement.closest('.app-instructor-hover') || toElement.closest('#app-instructor-tooltip'))) {
      return;
    }

    const fromTooltip = e.target.closest('#app-instructor-tooltip');
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
    const target = e.target.closest('.app-instructor-hover');
    if (!target) return;
    if (instructorTooltip.classList.contains('show')) {
      positionTooltip(target, instructorTooltip);
    }
  });

  // Delegated mouse hover listeners for occupancy tooltip
  document.body.addEventListener('mouseover', (e) => {
    const target = e.target.closest('.app-occupancy-hover');
    const tooltip = e.target.closest('#app-occupancy-tooltip');

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
          <div class="tip-loading-box">${renderFloorPlanSkeleton(COPY.occupancy.loadingLayout, 3)}</div>
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
              <div class="tip-error-box">
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
    const target = e.target.closest('.app-occupancy-hover');
    const toElement = e.relatedTarget;

    if (toElement && (toElement.closest('.app-occupancy-hover') || toElement.closest('#app-occupancy-tooltip'))) {
      return;
    }

    const fromTooltip = e.target.closest('#app-occupancy-tooltip');
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
    const target = e.target.closest('.app-occupancy-hover');
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
  // Never run off the bottom (taller popup, small mobile viewport): clamp, keep a 10px margin.
  if (top + tooltipRect.height > window.innerHeight - 10) {
    top = Math.max(10, window.innerHeight - tooltipRect.height - 10);
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
      <div class="tip-title-center">
        ${COPY.occupancy.class}
      </div>
      <div class="tip-stats-grid">
        <div class="tip-stat-item">
          <div class="tip-stat-label">${COPY.occupancy.total}</div>
          <div class="tip-stat-total">${totalSlots || 'N/A'}</div>
        </div>
        <div class="tip-stat-item">
          <div class="tip-stat-label">${COPY.occupancy.open}</div>
          <div class="tip-stat-open">${openSlots}</div>
        </div>
        <div class="tip-stat-item">
          <div class="tip-stat-label">${COPY.occupancy.booked}</div>
          <div class="tip-stat-booked">${occupiedSlots}</div>
        </div>
      </div>
    `;
    return;
  }

  // Same display-only rotation as the booking maps (mobile width, studios whose policy asks for it).
  const rotation = effectiveRotation(
    payload.mobileRotation ?? mobileRotationForStudio(payload.event?.studioId ?? payload.studioId, payload.event?.gymId ?? payload.gymId),
  );
  const front = payload.front ?? frontForStudio(payload.event?.studioId ?? payload.studioId, payload.event?.gymId ?? payload.gymId);
  const frontSide = displayFrontSide(front, rotation);
  const rotate = makeDisplayRotator([...layoutSlots, ...layoutObjects], rotation);
  layoutSlots = layoutSlots.map(rotate);
  layoutObjects = layoutObjects.map(rotate);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  layoutSlots.forEach(s => {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  });

  const widthRange = maxX - minX || 1;
  const heightRange = maxY - minY || 1;

  // Uniform scale (aspect ratio kept, centred) in the 150px minimap box, instead of stretching each axis.
  const fit = layoutSlots.length ? makeUniformFit(layoutSlots, { boxW: 220, boxH: 150, pad: frontSide ? 8 + FRONT_BAR_PX : 8, itemPx: 10, minGapPx: 0 }) : null;
  let stageHtml = '';
  layoutObjects.forEach(obj => {
    const left = fit ? fit.xPct(obj.x) : 50;
    const top = fit ? fit.yPct(obj.y) : 50;
    stageHtml += `
      <div class="app-minimap-stage" style="left: ${left}%; top: ${top}%; transform: translate(-50%, -50%);">
        ${COPY.tooltips.stage}
      </div>
    `;
  });

  let dotsHtml = '';
  layoutSlots.forEach(slot => {
    const isAvailable = availableSlotIds.has(String(slot.id));
    const left = fit.xPct(slot.x);
    const top = fit.yPct(slot.y);
    const label = slot.label || slot.id;

    dotsHtml += `
      <div class="app-minimap-dot ${isAvailable ? 'available' : 'occupied'}" title="${label}" style="left: ${left}%; top: ${top}%;"></div>
    `;
  });

  // Open spots the studio layout has no position for.
  const layoutSlotIds = new Set(layoutSlots.map(s => String(s.id)));
  const unmappedCount = [...availableSlotIds].filter(id => !layoutSlotIds.has(id)).length;
  let extraSlotsHtml = '';
  if (unmappedCount > 0) {
    extraSlotsHtml += `
      <div class="tip-footer-box">
        ${formatCopyText(COPY.tooltips.unmappedSpots, { count: unmappedCount })}
      </div>
    `;
  }

  occupancyTooltip.innerHTML = `
    <div class="tip-header-title">
      ${COPY.occupancy.studio}
    </div>
    <div class="tip-header-row">
      <span>Total: ${totalSlots || 'N/A'}</span>
      <span class="tip-badge-open">Open: ${openSlots}</span>
      <span class="tip-badge-booked">Booked: ${occupiedSlots}</span>
    </div>
    <div class="app-minimap-container">
      ${stageHtml}
      ${dotsHtml}
    </div>
    ${extraSlotsHtml}
    <div class="app-minimap-legend">
      <div class="app-minimap-legend-item">
        <div class="app-minimap-legend-dot available"></div>
        <span>${COPY.occupancy.available}</span>
      </div>
      <div class="app-minimap-legend-item">
        <div class="app-minimap-legend-dot occupied"></div>
        <span>${COPY.occupancy.booked}</span>
      </div>
    </div>
  `;
  const bar = makeFrontBar(frontSide);
  const miniBox = occupancyTooltip.querySelector('.app-minimap-container');
  if (bar && miniBox) { miniBox.style.position = 'relative'; miniBox.appendChild(bar); }
}
