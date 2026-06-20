// Shared preferred-spot-map editor.
//
// One studio has ONE shared preferred spot map (`studioPreferences[studioId]`)
// that is the single source of truth for quick-book, auto-book, and auto-upgrade.
// This renderer is reused everywhere the map is edited so behaviour stays identical.
//
// renderStudioFloorPlan(container, layoutSlots, initialSlots, initialRows, onSave, options)
//   onSave(selectedSlots, selectedRows, container) — called when the user saves.
//   options.saveLabel     — text for the primary save button (default "Save Defaults").
//   options.bannerHtml    — optional HTML shown above the floor plan (e.g. shared-map notice).
//   options.extraControlsHtml — optional HTML inserted just above the action buttons
//                               (e.g. a per-entry toggle). Read it back in onSave via the
//                               container reference.
//   options.onDisable     — optional callback for a disable button.
//   options.disableLabel  — text for the disable button (shown if onDisable is provided).

export function renderStudioFloorPlan(container, layoutSlots, initialSlots, initialRows, onSave, options = {}) {
  const { saveLabel = 'Save Defaults', bannerHtml = '', extraControlsHtml = '', onDisable = null, disableLabel = 'Disable' } = options;

  const selectedSlots = [...initialSlots];
  const selectedRows = new Set(initialRows);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  layoutSlots.forEach(s => {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.y < minY) minY = s.y;
    if (s.y > maxY) maxY = s.y;
  });
  const widthRange = maxX - minX || 1;
  const heightRange = maxY - minY || 1;
  const rowYs = [...new Set(layoutSlots.map(s => s.y))].sort((a, b) => a - b);
  const slotsByRow = new Map();
  rowYs.forEach(y => { slotsByRow.set(y, layoutSlots.filter(s => s.y === y)); });

  const render = () => {
    container.innerHTML = '';

    // Optional banner (e.g. shared-map notice)
    if (bannerHtml) {
      const banner = document.createElement('div');
      banner.innerHTML = bannerHtml;
      container.appendChild(banner);
    }

    // Summary line
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:12px;color:var(--text-secondary);margin-bottom:10px;min-height:16px;';
    const spotLabels = selectedSlots.map(id => {
      const slot = layoutSlots.find(s => Number(s.id) === id);
      return slot?.label || slot?.slot || String(id);
    });
    const rowLabels = Array.from(selectedRows).map(y => {
      const idx = rowYs.indexOf(y);
      return idx >= 0 ? String(idx + 1) : String(y);
    });
    const parts = [];
    if (spotLabels.length > 0) parts.push(`Spots [${spotLabels.join(', ')}]`);
    if (rowLabels.length > 0) parts.push(`Rows [${rowLabels.join(', ')}]`);
    summary.textContent = parts.length ? `Selected Preferences: ${parts.join(' > ')}` : '(None selected yet)';
    container.appendChild(summary);

    // Floor plan
    const aspectPct = (heightRange / widthRange * 90).toFixed(1);
    const floor = document.createElement('div');
    floor.style.cssText = `position:relative;width:100%;padding-bottom:${aspectPct}%;background:color-mix(in srgb, var(--bg) 60%, transparent);border:1px solid color-mix(in srgb, var(--text) 8%, transparent);border-radius:8px;margin-bottom:14px;`;

    // Row backdrops
    selectedRows.forEach(y => {
      const rowSlots = slotsByRow.get(y) || [];
      if (rowSlots.length === 0) return;
      const minYinRow = Math.min(...rowSlots.map(s => s.y));
      const maxYinRow = Math.max(...rowSlots.map(s => s.y));
      const minXinRow = Math.min(...rowSlots.map(s => s.x));
      const maxXinRow = Math.max(...rowSlots.map(s => s.x));

      const left = widthRange === 0 ? 5 : ((minXinRow - minX) / widthRange) * 78 + 5;
      const top = heightRange === 0 ? 10 : ((minYinRow - minY) / heightRange) * 72 + 10;
      const width = widthRange === 0 ? 70 : ((maxXinRow - minXinRow) / widthRange) * 78 + 8;
      const height = heightRange === 0 ? 70 : ((maxYinRow - minYinRow) / heightRange) * 72 + 8;

      const backdrop = document.createElement('div');
      backdrop.style.cssText = `position:absolute;left:${left}%;top:${top}%;width:${width}%;height:${height}%;background:color-mix(in srgb, var(--info) 10%, transparent);border:2px solid color-mix(in srgb, var(--info) 30%, transparent);border-radius:12px;pointer-events:none;z-index:0;`;
      floor.appendChild(backdrop);
    });

    // Slots
    layoutSlots.forEach(slot => {
      const slotId = Number(slot.id);
      const priority = selectedSlots.indexOf(slotId) + 1;
      const inRow = selectedRows.has(slot.y);

      const left = widthRange === 0 ? 50 : ((slot.x - minX) / widthRange) * 78 + 8;
      const top = heightRange === 0 ? 50 : ((slot.y - minY) / heightRange) * 72 + 14;
      const label = slot.label || slot.slot || String(slotId);

      const el = document.createElement('div');
      el.style.cssText = `position:absolute;left:${left}%;top:${top}%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;cursor:pointer;user-select:none;transition:all 0.1s;box-sizing:border-box;z-index:1;`;
      el.title = `Spot${label}`;

      if (priority > 0) {
        el.style.background = 'var(--feat-autoupgrade)';
        el.style.border = '2px solid var(--feat-autoupgrade)';
        el.style.color = '#fff';
        el.textContent = String(priority);
      } else if (inRow) {
        el.style.background = 'color-mix(in srgb, var(--info) 25%, transparent)';
        el.style.border = '1px solid color-mix(in srgb, var(--info) 50%, transparent)';
        el.style.color = 'var(--info)';
        el.textContent = label;
      } else {
        el.style.background = 'color-mix(in srgb, var(--text) 5%, transparent)';
        el.style.border = '1px solid color-mix(in srgb, var(--text) 8%, transparent)';
        el.style.color = 'var(--text-tertiary)';
        el.textContent = label;
      }

      el.addEventListener('click', () => {
        const idx = selectedSlots.indexOf(slotId);
        if (idx !== -1) selectedSlots.splice(idx, 1);
        else selectedSlots.push(slotId);
        render();
      });

      floor.appendChild(el);
    });

    // Row +/- buttons
    if (rowYs.length > 1) {
      rowYs.forEach((y, idx) => {
        const isOn = selectedRows.has(y);
        const rowSlots = slotsByRow.get(y) || [];
        if (rowSlots.length === 0) return;
        const midY = (Math.min(...rowSlots.map(s => s.y)) + Math.max(...rowSlots.map(s => s.y))) / 2;

        const top = heightRange === 0 ? 50 : ((midY - minY) / heightRange) * 72 + 14;
        const btn = document.createElement('button');
        btn.style.cssText = `position:absolute;left:95.5%;top:${top}%;transform:translate(-50%,-50%);width:26px;height:26px;padding:0;border-radius:50%;background:${isOn ? 'color-mix(in srgb, var(--info) 30%, transparent)' : 'color-mix(in srgb, var(--text) 8%, transparent)'};border:1px solid ${isOn ? 'color-mix(in srgb, var(--info) 50%, transparent)' : 'color-mix(in srgb, var(--text) 15%, transparent)'};color:${isOn ? 'var(--info)' : 'var(--text-secondary)'};font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.1s;z-index:2;`;
        btn.textContent = isOn ? '−' : '+';
        btn.title = isOn ? `Remove Row ${idx + 1}` : `Add Row ${idx + 1}`;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectedRows.has(y)) selectedRows.delete(y);
          else selectedRows.add(y);
          render();
        });
        floor.appendChild(btn);
      });
    }

    container.appendChild(floor);

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

    const clearBtn = document.createElement('button');
    clearBtn.className = 'psycle-btn';
    clearBtn.style.cssText = 'flex:1;background:color-mix(in srgb, var(--text) 6%, transparent);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);color:var(--text);';
    clearBtn.textContent = 'Clear Defaults';
    clearBtn.onclick = () => { selectedSlots.length = 0; selectedRows.clear(); render(); };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'psycle-btn';
    saveBtn.style.cssText = `flex:${onDisable ? '1' : '2'};background:var(--feat-autoupgrade);color:#fff;`;
    saveBtn.textContent = saveLabel;
    saveBtn.onclick = () => onSave([...selectedSlots], [...selectedRows], container);

    actions.appendChild(clearBtn);
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

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--text-tertiary);margin-top:8px;text-align:center;';
    hint.textContent = 'Click on the spots to set your priority order. Click the + button on the right to prefer entire rows.';
    container.appendChild(hint);
  };

  render();
}
