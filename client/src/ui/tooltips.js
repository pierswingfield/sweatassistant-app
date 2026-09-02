import { api } from '../api';
import { metadata } from './timetable';

let occupancyHoverTimeout = null;
let occupancyHideTimeout = null;
let activeOccupancyHoverTarget = null;
const eventDetailsCache = new Map();

let hoverTimeout = null;
let hideTimeout = null;
let activeHoverTarget = null;

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

function instructorTooltipHTML(instructorIdRaw) {
  const instructorId = parseInt(instructorIdRaw);
  // Normalized ids are strings; instructorId comes off a raw event as a number.
  const instructor = metadata.instructors.find(i => String(i.id) === String(instructorId));
  if (!instructor) return null;

  const photoUrl = instructor.photo || instructor.image_1 || '';
  const avatarHtml = photoUrl
    ? `<img src="${photoUrl}" class="psycle-tooltip-avatar" alt="${instructor.full_name || instructor.name}">`
    : `<div class="psycle-tooltip-avatar" style="display:flex; align-items:center; justify-content:center; background:color-mix(in srgb, var(--text) 8%, transparent); font-weight:bold; font-size:16px; color:#fff;">${(instructor.full_name || instructor.name || '?')[0]}</div>`;

  const name = instructor.full_name || instructor.name || 'Instructor';
  const keywords = instructor.metafields?.keywords ? instructor.metafields.keywords.replace(/\|/g, ' • ') : '';
  const description = instructor.metafields?.description || '';

  let instagramHtml = '';
  const igRaw = instructor.metafields?.instagram_handle || instructor.instagram_handle;
  const igHandle = parseInstagramHandle(igRaw);
  if (igHandle) {
    instagramHtml = `<a class="psycle-tooltip-social-link" href="https://instagram.com/${igHandle}" target="_blank" rel="noopener noreferrer">📸 @${igHandle}</a>`;
  }
  let spotifyHtml = '';
  const spRaw = instructor.metafields?.spotify_handle || instructor.spotify_handle;
  const spId = parseSpotifyUserId(spRaw);
  if (spId) {
    spotifyHtml = `<a class="psycle-tooltip-social-link" href="https://open.spotify.com/user/${spId}" target="_blank" rel="noopener noreferrer">🎵 @${spId}</a>`;
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
      const html = instructorTooltipHTML(target.getAttribute('data-id'));
      if (!html) return;
      instructorTooltip.innerHTML = html;
      instructorTooltip.style.display = 'block';
      positionTooltip(target, instructorTooltip);
      instructorTooltip.offsetHeight;
      instructorTooltip.classList.add('show');
    }, 1000); // 1s delay
  });

  // Touch devices have no hover — tap an instructor name to toggle the tooltip,
  // and tap anywhere else to dismiss it.
  if (window.matchMedia('(hover: none)').matches) {
    const hideInstructor = () => {
      activeHoverTarget = null;
      instructorTooltip.classList.remove('show');
      instructorTooltip.style.display = 'none';
    };
    document.body.addEventListener('click', (e) => {
      const target = e.target.closest('.psycle-instructor-hover');
      if (!target) {
        if (instructorTooltip.classList.contains('show')) hideInstructor();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      // Tapping the open instructor again closes it.
      if (activeHoverTarget === target && instructorTooltip.classList.contains('show')) {
        hideInstructor();
        return;
      }
      const html = instructorTooltipHTML(target.getAttribute('data-id'));
      if (!html) return;
      activeHoverTarget = target;
      instructorTooltip.innerHTML = html;
      instructorTooltip.style.display = 'block';
      positionTooltip(target, instructorTooltip);
      instructorTooltip.offsetHeight;
      instructorTooltip.classList.add('show');
    });
  }

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

      occupancyTooltip.style.display = 'block';
      positionTooltip(target, occupancyTooltip);
      occupancyTooltip.offsetHeight;
      occupancyTooltip.classList.add('show');

      if (eventDetailsCache.has(eventId)) {
        renderMinimap(eventDetailsCache.get(eventId), occupancyTooltip);
      } else {
        occupancyTooltip.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:center; padding:15px; color:var(--text); font-size:12px;">
            <svg class="psycle-spinner-svg" viewBox="0 0 24 24" style="animation: spin 1s linear infinite; width: 14px; height: 14px; margin-right: 8px; color: var(--feat-autoupgrade); display: inline-block;">
              <circle cx="12" cy="12" r="10" stroke="color-mix(in srgb, var(--text) 15%, transparent)" stroke-width="3" fill="none"></circle>
              <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor"></path>
            </svg>
            <span style="margin-left: 6px;">Loading layout...</span>
          </div>
        `;
        positionTooltip(target, occupancyTooltip);

        try {
          const res = await api.getEventDetails(eventId);
          eventDetailsCache.set(eventId, res);
          if (activeOccupancyHoverTarget === target) {
            renderMinimap(res, occupancyTooltip);
          }
        } catch (err) {
          console.error('[Timetable] Failed to fetch event slots for minimap:', err);
          if (activeOccupancyHoverTarget === target) {
            occupancyTooltip.innerHTML = `
              <div style="padding: 10px; color: var(--danger); font-size: 12px; text-align: center; font-weight: 500;">
                Failed to load slot layout.
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
  const isNormalized = Array.isArray(payload?.slots) && payload.slots.some((s) => s && typeof s === 'object');

  let layoutSlots, layoutObjects, availableSlotIds, totalSlots, openSlots;
  if (isNormalized) {
    layoutSlots = payload.slots;
    layoutObjects = payload.objects || [];
    availableSlotIds = new Set(layoutSlots.filter((s) => s.isAvailable).map((s) => Number(s.id)));
    openSlots = availableSlotIds.size;
    totalSlots = payload.event?.capacity || layoutSlots.length || 0;
  } else {
    const eventData = payload.data || payload;
    const studio = payload.relations?.studios?.[0] || eventData.relations?.studios?.[0] || eventData.studio || {};
    layoutSlots = studio?.layout?.slots || [];
    layoutObjects = studio?.layout?.objects || [];
    const availableSlots = payload.slots || eventData.slots || [];
    availableSlotIds = new Set(availableSlots.map((id) => Number(id)));
    totalSlots = eventData.capacity || layoutSlots.length || 0;
    openSlots = availableSlots.length;
  }

  const occupiedSlots = Math.max(0, totalSlots - openSlots);

  let minimapContentHtml = '';

  if (layoutSlots.length > 0) {
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
          Stage
        </div>
      `;
    });

    let dotsHtml = '';
    layoutSlots.forEach(slot => {
      const isAvailable = availableSlotIds.has(Number(slot.id));
      const left = widthRange === 0 ? 50 : ((slot.x - minX) / widthRange) * 80 + 10;
      const top = heightRange === 0 ? 50 : ((slot.y - minY) / heightRange) * 70 + 15;
      const label = slot.label || slot.id;

      dotsHtml += `
        <div class="psycle-minimap-dot ${isAvailable ? 'available' : 'occupied'}" title="${label}" style="left: ${left}%; top: ${top}%;"></div>
      `;
    });

    // Open spots the studio layout has no position for. On the normalized shape
    // every available slot IS a layout slot (they are the same objects), so this
    // is always zero — it only ever meant something for CodexFit's split
    // "layout here, available ids there" response. Computed from the shared
    // `availableSlotIds` set so it works for both shapes.
    const layoutSlotIds = new Set(layoutSlots.map(s => Number(s.id)));
    const unmappedCount = [...availableSlotIds].filter(id => !layoutSlotIds.has(id)).length;
    let extraSlotsHtml = '';
    if (unmappedCount > 0) {
      extraSlotsHtml += `
        <div style="font-size: 12px; color: var(--text-secondary); text-align: center; margin-top: 4px; border-top: 1px solid color-mix(in srgb, var(--text) 6%, transparent); padding-top: 4px;">
          + ${unmappedCount} unmapped open spots
        </div>
      `;
    }

    minimapContentHtml = `
      <div class="psycle-minimap-container">
        ${stageHtml}
        ${dotsHtml}
      </div>
      ${extraSlotsHtml}
    `;
  } else {
    minimapContentHtml = `
      <div style="padding: 20px 10px; color: var(--text-secondary); font-size: 12px; text-align: center; font-style: italic;">
        No floor map layout available.
      </div>
    `;
  }

  occupancyTooltip.innerHTML = `
    <div style="font-size: 12px; font-weight: 700; color: var(--text); text-align: center; margin-bottom: 4px;">
      Studio Occupancy
    </div>
    <div style="font-size: 12px; color: var(--text-secondary); display: flex; justify-content: space-between; margin-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--text) 8%, transparent); padding-bottom: 4px;">
      <span>Total: ${totalSlots || 'N/A'}</span>
      <span style="color:var(--success);">Open: ${openSlots}</span>
      <span style="color:var(--danger);">Booked: ${occupiedSlots}</span>
    </div>
    ${minimapContentHtml}
    <div class="psycle-minimap-legend">
      <div class="psycle-minimap-legend-item">
        <div class="psycle-minimap-legend-dot available"></div>
        <span>Available</span>
      </div>
      <div class="psycle-minimap-legend-item">
        <div class="psycle-minimap-legend-dot occupied"></div>
        <span>Booked</span>
      </div>
    </div>
  `;
}
