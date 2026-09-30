import { shortSlotLabels, escapeHtml } from './cards';
import { COPY, formatCopyText } from '../copy.js';
// Shared preferred-spot-map editor.
//
// One studio has ONE shared preferred spot map (`studioPreferences[studioId]`)
// that is the single source of truth for quick-book, auto-book, and auto-upgrade.
// This renderer is reused everywhere the map is edited so behaviour stays identical.
//
// Data contract (WP-C5): `layoutSlots` is a NormalizedSlot[] and
// `options.layoutObjects` a NormalizedLayoutObject[], both straight from the
// provider adapter — never a raw CodexFit/MarianaTek shape. Slot ids arrive as
// strings and are compared as numbers here, matching how preferred-spot maps
// are persisted (`preferredSlots: number[]`); both providers' spot ids are
// numeric, so the coercion is lossless (see PROGRESS.md Open Questions if a
// future provider ever uses non-numeric ids).
//
// renderStudioFloorPlan(container, layoutSlots, initialSlots, initialRows, onSave, options)
//   onSave(selectedSlots, selectedRows, container) — called when the user saves.
//   options.saveLabel     — text for the primary save button (default "Save Defaults").
//   options.bannerHtml    — optional HTML shown above the floor plan (e.g. shared-map notice).
//   options.bannerHtmlEdit — optional HTML that replaces bannerHtml once the user enters
//                            edit mode (only used when readOnly is set).
//   options.extraControlsHtml — optional HTML inserted just above the action buttons
//                               (e.g. a per-entry toggle). Read it back in onSave via the
//                               container reference.
//   options.onDisable     — optional callback for a disable button.
//   options.disableLabel  — text for the disable button (shown if onDisable is provided).
//   options.readOnly      — when true, the map starts locked (slots not clickable, no row
//                            +/- buttons) and a wide edit button is shown beneath the map.
//                            Clicking it unlocks editing.
//   options.editLabel     — text for the unlock button shown in read-only mode.
//   options.hideClear     — when true, the "Clear Defaults" action button is omitted.

export function renderStudioFloorPlan(container, layoutSlots, initialSlots, initialRows, onSave, options = {}) {
  const {
    saveLabel = COPY.spotMapEditor.saveDefaults,
    bannerHtml = '',
    bannerHtmlEdit = '',
    extraControlsHtml = '',
    onDisable = null,
    disableLabel = COPY.spotMapEditor.disable,
    readOnly = false,
    editLabel = COPY.spotMapEditor.editPreferredSpots,
    hideClear = false,
    layoutObjects = [],
    availableSlots = null,
    currentSlotId = null
  } = options;

  // In read-only mode the map starts locked until the user clicks the edit button.
  let editing = !readOnly;

  const selectedSlots = [...initialSlots];
  const selectedRows = new Set(initialRows);

  const mapChanged = () => {
    if (selectedSlots.length !== initialSlots.length) return true;
    if (selectedSlots.some((id, i) => id !== initialSlots[i])) return true;
    if (selectedRows.size !== initialRows.length) return true;
    for (const r of selectedRows) if (!initialRows.includes(r)) return true;
    return false;
  };

  // Bounds include podium/stage objects so the floor expands to fit them (the
  // scale below still measures slot spacing only — a podium isn't a seat).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  [...layoutSlots, ...layoutObjects].forEach(s => {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  });
  const widthRange = maxX - minX || 1;
  const heightRange = maxY - minY || 1;
  // Short labels ("27" rather than "Bike 27") — see shortSlotLabels. The full
  // label stays in each square's tooltip and in the caption above the map.
  const shortLabels = shortSlotLabels(layoutSlots);
  const rowYs = [...new Set(layoutSlots.map(s => s.y))].sort((a, b) => a - b);
  const slotsByRow = new Map();
  rowYs.forEach(y => { slotsByRow.set(y, layoutSlots.filter(s => s.y === y)); });

  // --- Floor-plan geometry (pixel-based to guarantee minimum gaps) ---
  const SLOT_SIZE = 28;
  const MIN_GAP = 32;   // min center-to-center px — just enough so 28px slots don't overlap (4px edge gap)
  const EDGE_PAD = 14;  // padding inside the floor around the slot field
  const isMobile = window.matchMedia('(max-width: 768px)').matches;
  // Smallest centre-to-centre distance between any two slots, in coordinate units.
  // Ride studios stagger alternate rows, so two slots can share a near-identical X
  // while sitting in different rows (far apart in 2D). Measuring true 2D nearest-
  // neighbour distance — not per-axis spacing — stops that half-bike X stagger from
  // being mistaken for an adjacent-seat gap and blowing the scale up (which made the
  // floor render thousands of px wide and spill past the card).
  let minNeighbourDist = Infinity;
  for (let i = 0; i < layoutSlots.length; i++) {
    for (let j = i + 1; j < layoutSlots.length; j++) {
      const d = Math.hypot(layoutSlots[i].x - layoutSlots[j].x, layoutSlots[i].y - layoutSlots[j].y);
      if (d > 0 && d < minNeighbourDist) minNeighbourDist = d;
    }
  }
  if (!isFinite(minNeighbourDist) || minNeighbourDist <= 0) minNeighbourDist = 1;
  // Pixels per coordinate unit so the closest pair of slots keeps MIN_GAP between
  // centres (>= SLOT_SIZE, so adjacent 28px slots never overlap).
  const minGapScale = MIN_GAP / minNeighbourDist;

  const render = () => {
    container.innerHTML = '';

    // Optional banner (e.g. shared-map notice). Swaps to the edit-mode banner once unlocked.
    const activeBanner = editing && bannerHtmlEdit ? bannerHtmlEdit : bannerHtml;
    if (activeBanner) {
      const banner = document.createElement('div');
      banner.innerHTML = activeBanner;
      container.appendChild(banner);
    }

    // Summary line
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:12px;margin-bottom:10px;min-height:16px;';
    const spotLabels = selectedSlots.map(id => {
      const slot = layoutSlots.find(s => Number(s.id) === id);
      return slot?.label || String(id);
    });
    const rowLabels = Array.from(selectedRows).map(y => {
      const idx = rowYs.indexOf(y);
      return idx >= 0 ? String(idx + 1) : String(y);
    });
    if (spotLabels.length === 0 && rowLabels.length === 0) {
      summary.innerHTML = `<span style="color:var(--text-tertiary);font-style:italic;">${COPY.spotMapEditor.noneSelected}</span>`;
    } else {
      const fmt = (labels, noun) => {
        const shown = labels.slice(0, 3);
        const rest = labels.length > 3 ? ` <span style="color:var(--text-tertiary);">${formatCopyText(COPY.spotMapEditor.moreCount, { count: labels.length - 3 })}</span>` : '';
        return `<span style="color:var(--text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;">${noun}</span> <span style="color:var(--text);font-weight:700;">${shown.map(escapeHtml).join(', ')}</span>${rest}`;
      };
      const parts = [];
      if (spotLabels.length > 0) parts.push(fmt(spotLabels, COPY.spotMapEditor.spots));
      if (rowLabels.length > 0) parts.push(fmt(rowLabels, COPY.spotMapEditor.rows));
      const sep = ' <span style="color:var(--text-tertiary);margin:0 4px;">›</span> ';
      summary.innerHTML = `<span style="color:var(--text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:0.05em;margin-right:6px;">${COPY.spotMapEditor.preferred}</span>${parts.join(sep)}`;
    }
    container.appendChild(summary);

    // --- Floor plan ---
    // Pixel-based layout: the scale fills the available width but never drops below
    // the min-gap scale, so adjacent slots always keep >= MIN_GAP px between centres
    // (no overlap). When the min-gap width exceeds the viewport the map pans.
    const scroll = document.createElement('div');
    scroll.className = 'psycle-floor-scroll';
    container.appendChild(scroll); // append now to measure its real width (CSS breakout on mobile)

    // Reserve a lane on the right for the row +/- buttons so they sit beside the
    // slot field rather than on top of the rightmost slot column (which hid them).
    const ROW_BTN = 26;
    const hasRowButtons = editing && rowYs.length > 1;
    const rowLaneW = hasRowButtons ? ROW_BTN + 8 : 0;

    const availW = scroll.clientWidth || (window.innerWidth - 80);
    // Mirror .psycle-floor-scroll's max-height (min(60vh, 460px)) so we can fit
    // the map within the box's height too, not just its width.
    const availH = Math.min(window.innerHeight * 0.6, 460);
    const fillScaleW = widthRange > 0 ? (availW - SLOT_SIZE - EDGE_PAD * 2 - rowLaneW) / widthRange : minGapScale;
    const fillScaleH = heightRange > 0 ? (availH - SLOT_SIZE - EDGE_PAD * 2 - 2) / heightRange : minGapScale;
    // Contain: fill the available box on whichever axis is tighter. Scaling is
    // uniform, so stretching a few-column studio (e.g. Reformer) to fill the full
    // width also blew its row spacing up and forced vertical panning. Fitting the
    // height instead keeps the rows compact and the whole map on screen.
    const fillScale = Math.min(fillScaleW, fillScaleH);
    // On mobile, don't stretch to fill — use the minimum scale so gaps stay
    // tight (just enough to avoid overlap) and any overflow pans inside the
    // scroll container. On desktop, fill the available box for a roomier map.
    const scale = isMobile ? minGapScale : Math.max(fillScale, minGapScale);

    // Scale X-axis and Y-axis independently if Y-axis gaps are too large and make the map spill.
    const scaleX = scale;
    let scaleY = scale;
    const maxFieldH = availH - SLOT_SIZE - EDGE_PAD * 2;
    if (heightRange > 0 && scaleY * heightRange > maxFieldH) {
      scaleY = maxFieldH / heightRange;
      // Guarantee vertical slots do not overlap by checking min vertical coordinate diff
      let minVerticalDist = Infinity;
      for (let i = 0; i < layoutSlots.length; i++) {
        for (let j = i + 1; j < layoutSlots.length; j++) {
          const dy = Math.abs(layoutSlots[i].y - layoutSlots[j].y);
          if (dy > 0.01 && dy < minVerticalDist) minVerticalDist = dy;
        }
      }
      if (isFinite(minVerticalDist) && minVerticalDist > 0) {
        const minVerticalScale = MIN_GAP / minVerticalDist;
        if (scaleY < minVerticalScale) scaleY = minVerticalScale;
      }
    }

    const floorW = Math.ceil(widthRange * scaleX + SLOT_SIZE + EDGE_PAD * 2 + rowLaneW);
    const floorH = Math.ceil(heightRange * scaleY + SLOT_SIZE + EDGE_PAD * 2);

    const floor = document.createElement('div');
    floor.className = 'psycle-floor';
    floor.style.width = floorW + 'px';
    floor.style.height = floorH + 'px';
    scroll.appendChild(floor);

    const pxX = x => (x - minX) * scaleX + EDGE_PAD + SLOT_SIZE / 2;
    const pxY = y => (y - minY) * scaleY + EDGE_PAD + SLOT_SIZE / 2;

    // Row backdrops
    selectedRows.forEach(y => {
      const rowSlots = slotsByRow.get(y) || [];
      if (rowSlots.length === 0) return;
      const minXinRow = Math.min(...rowSlots.map(s => s.x));
      const maxXinRow = Math.max(...rowSlots.map(s => s.x));
      const minYinRow = Math.min(...rowSlots.map(s => s.y));
      const maxYinRow = Math.max(...rowSlots.map(s => s.y));
      const backdrop = document.createElement('div');
      backdrop.style.cssText = `position:absolute;left:${pxX(minXinRow) - SLOT_SIZE / 2}px;top:${pxY(minYinRow) - SLOT_SIZE / 2}px;width:${(maxXinRow - minXinRow) * scaleX + SLOT_SIZE}px;height:${(maxYinRow - minYinRow) * scaleY + SLOT_SIZE}px;background:color-mix(in srgb, var(--info) 10%, transparent);border:2px solid color-mix(in srgb, var(--info) 30%, transparent);border-radius:12px;pointer-events:none;z-index:0;`;
      floor.appendChild(backdrop);
    });

    // Slots
    layoutSlots.forEach(slot => {
      const slotId = Number(slot.id);
      const priority = selectedSlots.indexOf(slotId) + 1;
      const inRow = selectedRows.has(slot.y);
      const label = slot.label || String(slotId);
      const short = shortLabels.get(String(slot.id)) || label;

      const hasAvailability = !!availableSlots;
      const isAvailable = !hasAvailability || availableSlots.includes(slotId);
      const isCurrent = currentSlotId !== null && Number(currentSlotId) === slotId;

      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:${pxX(slot.x)}px;top:${pxY(slot.y)}px;transform:translate(-50%,-50%);width:${SLOT_SIZE}px;height:${SLOT_SIZE}px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;line-height:1;text-align:center;white-space:nowrap;overflow:visible;cursor:${editing ? 'pointer' : 'default'};user-select:none;transition:all 0.1s;box-sizing:border-box;z-index:1;`;
      el.title = `Spot ${label}`;

      /**
       * A selected spot keeps its OWN label and shows its priority as a corner
       * badge. It used to do `el.textContent = String(priority)`, replacing
       * "Bike 27" with "1" — so the map showed "1, 2" while the caption
       * underneath read "Preferred spots: Bike 27, Bike 28" and there was no way
       * to tell which square was which bike. The ranking is secondary
       * information; which seat it is, is the primary information.
       */
      const withPriorityBadge = (n) => {
        el.textContent = short;
        const badge = document.createElement('span');
        badge.textContent = String(n);
        badge.setAttribute('aria-hidden', 'true');
        badge.style.cssText = 'position:absolute;top:-6px;right:-6px;min-width:15px;height:15px;padding:0 3px;border-radius:999px;background:var(--feat-autoupgrade);color:#fff;font-size:9px;line-height:15px;font-weight:800;text-align:center;box-shadow:0 0 0 2px var(--surface);box-sizing:border-box;';
        el.appendChild(badge);
        el.title = formatCopyText(COPY.spotMapEditor.preferredPriority, { label, priority: n });
      };

      if (isCurrent) {
        el.style.background = 'color-mix(in srgb, var(--feat-autoupgrade) 15%, transparent)';
        el.style.border = '2px dashed var(--feat-autoupgrade)';
        el.style.color = 'var(--feat-autoupgrade)';
        el.textContent = short;
        el.title = formatCopyText(COPY.spotMapEditor.currentSeat, { label });
        if (priority > 0) {
          el.style.background = 'var(--feat-autoupgrade)';
          el.style.border = '2px dashed #fff';
          el.style.color = '#fff';
          withPriorityBadge(priority);
          el.title = formatCopyText(COPY.spotMapEditor.currentPreferredPriority, { label, priority });
        }
      } else if (priority > 0) {
        el.style.background = 'var(--feat-autoupgrade)';
        el.style.border = '2px solid var(--feat-autoupgrade)';
        el.style.color = '#fff';
        withPriorityBadge(priority);
        if (hasAvailability && !isAvailable) {
          el.style.boxShadow = '0 0 0 2px var(--danger)';
          el.title = formatCopyText(COPY.spotMapEditor.occupiedPreferredSeat, { label });
        }
      } else if (inRow) {
        el.style.background = 'color-mix(in srgb, var(--info) 25%, transparent)';
        el.style.border = '1px solid color-mix(in srgb, var(--info) 50%, transparent)';
        el.style.color = 'var(--info)';
        el.textContent = short;
      } else if (hasAvailability && isAvailable) {
        el.style.background = 'color-mix(in srgb, var(--success) 15%, transparent)';
        el.style.border = '1px solid color-mix(in srgb, var(--success) 35%, transparent)';
        el.style.color = 'var(--success)';
        el.textContent = short;
      } else if (hasAvailability && !isAvailable) {
        el.style.background = 'var(--surface-inset)';
        el.style.border = '1px solid var(--border)';
        el.style.color = 'var(--text-tertiary)';
        el.textContent = short;
      } else {
        el.style.background = 'color-mix(in srgb, var(--text) 5%, transparent)';
        el.style.border = '1px solid color-mix(in srgb, var(--text) 8%, transparent)';
        el.style.color = 'var(--text-tertiary)';
        el.textContent = short;
      }

      if (editing) {
        el.addEventListener('click', () => {
          const idx = selectedSlots.indexOf(slotId);
          if (idx !== -1) selectedSlots.splice(idx, 1);
          else selectedSlots.push(slotId);
          render();
        });
      }

      floor.appendChild(el);
    });

    // Podium / stage objects (e.g. the instructor podium). Flat-coloured
    // markers — not seats, so they're non-interactive (no click, no pointer).
    // `obj.label` comes from NormalizedLayoutObject; providers that don't name
    // their fixtures fall back to the historic "P" / "Podium" pair.
    layoutObjects.forEach(obj => {
      const objLabel = obj.label || COPY.spotMapEditor.podium;
      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:${pxX(obj.x)}px;top:${pxY(obj.y)}px;transform:translate(-50%,-50%);width:${SLOT_SIZE + 14}px;height:${SLOT_SIZE}px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--text-secondary);color:var(--bg);user-select:none;pointer-events:none;box-sizing:border-box;z-index:1;`;
      el.textContent = objLabel[0].toUpperCase();
      el.title = objLabel;
      floor.appendChild(el);
    });

    // Row +/- buttons (only while editing) — placed in the reserved right-hand lane.
    if (hasRowButtons) {
      const rowBtnX = floorW - EDGE_PAD - rowLaneW / 2;
      rowYs.forEach((y, idx) => {
        const isOn = selectedRows.has(y);
        const rowSlots = slotsByRow.get(y) || [];
        if (rowSlots.length === 0) return;
        const midY = (Math.min(...rowSlots.map(s => s.y)) + Math.max(...rowSlots.map(s => s.y))) / 2;

        const btn = document.createElement('button');
        btn.style.cssText = `position:absolute;left:${rowBtnX}px;top:${pxY(midY)}px;transform:translate(-50%,-50%);width:26px;height:26px;padding:0;border-radius:50%;background:${isOn ? 'color-mix(in srgb, var(--info) 30%, transparent)' : 'color-mix(in srgb, var(--text) 8%, transparent)'};border:1px solid ${isOn ? 'color-mix(in srgb, var(--info) 50%, transparent)' : 'color-mix(in srgb, var(--text) 15%, transparent)'};color:${isOn ? 'var(--info)' : 'var(--text-secondary)'};font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.1s;z-index:2;`;
        btn.textContent = isOn ? '−' : '+';
        btn.title = isOn
          ? formatCopyText(COPY.timetable.removeRow, { row: idx + 1 })
          : formatCopyText(COPY.timetable.addRow, { row: idx + 1 });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectedRows.has(y)) selectedRows.delete(y);
          else selectedRows.add(y);
          render();
        });
        floor.appendChild(btn);
      });
    }

    // "Drag to pan" hint when the map overflows the scroll viewport
    if (floorW > scroll.clientWidth + 1 || floorH > scroll.clientHeight + 1) {
      const panHint = document.createElement('div');
      panHint.style.cssText = 'font-size:11px;color:var(--text-tertiary);font-style:italic;margin:-4px 0 10px;text-align:center;';
      panHint.textContent = COPY.spotMapEditor.dragToPan;
      container.appendChild(panHint);
    }

    // Read-only unlock button, attached beneath the map.
    if (!editing) {
      const editBtn = document.createElement('button');
      editBtn.className = 'psycle-btn';
      editBtn.style.cssText = 'width:100%;margin-bottom:14px;background:color-mix(in srgb, var(--feat-autoupgrade) 12%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 30%, transparent);color:var(--feat-autoupgrade);';
      editBtn.textContent = editLabel;
      editBtn.onclick = () => { editing = true; render(); };
      container.appendChild(editBtn);
    }

    // Hint text shown directly under the map when in edit mode
    if (editing) {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:12px;color:var(--text-secondary);font-style:italic;margin-bottom:12px;';
      hint.innerHTML = COPY.spotMapEditor.editInstructionHtml;
      container.appendChild(hint);
    }

    // Optional extra controls (e.g. a per-entry toggle)
    if (extraControlsHtml) {
      const extra = document.createElement('div');
      extra.style.cssText = 'margin-bottom:12px;';
      extra.innerHTML = extraControlsHtml;
      container.appendChild(extra);
    }

    // Actions
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;';

    if (!hideClear) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'psycle-btn';
      clearBtn.style.cssText = 'flex:1;background:color-mix(in srgb, var(--text) 6%, transparent);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);color:var(--text);';
      clearBtn.textContent = COPY.spotMapEditor.clearPreferences;
      clearBtn.onclick = () => { selectedSlots.length = 0; selectedRows.clear(); render(); };
      actions.appendChild(clearBtn);
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'psycle-btn';
    saveBtn.style.cssText = `flex:${onDisable && !hideClear ? '1' : '2'};background:var(--feat-autoupgrade);color:#fff;`;
    saveBtn.textContent = mapChanged() ? `${COPY.spotMapEditor.saveMapAnd} ${saveLabel}` : saveLabel;
    saveBtn.onclick = () => onSave([...selectedSlots], [...selectedRows], container);

    actions.appendChild(saveBtn);

    if (onDisable) {
      const disableBtn = document.createElement('button');
      disableBtn.className = 'psycle-btn';
      disableBtn.style.cssText = 'flex:1;background:color-mix(in srgb, var(--danger) 10%, transparent);border:1px solid color-mix(in srgb, var(--danger) 20%, transparent);color:var(--danger);';
      disableBtn.textContent = disableLabel;
      disableBtn.onclick = () => onDisable(container);
      actions.appendChild(disableBtn);
    }

    container.appendChild(actions);
  };

  render();

  // Re-fit when the container width changes (orientation change, modal resize).
  // Only width matters — height changes from our own content are ignored to
  // avoid render loops.
  let lastWidth = container.clientWidth;
  let resizeRaf = 0;
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    if (w === lastWidth || w === 0) return;
    lastWidth = w;
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => render());
  });
  ro.observe(container);
}
