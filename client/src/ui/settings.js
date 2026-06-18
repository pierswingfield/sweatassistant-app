import { api, apiFetch } from '../api';
import { showToast, togglePushSubscription, updatePushStatusUI, userSettings, cache } from '../main';
import { renderStudioFloorPlan } from './spotmap';

let loadedProfile = null;

async function loadProfileData() {
  const btn = document.getElementById('psycle-profile-load-btn');
  const content = document.getElementById('psycle-profile-content');
  if (!btn || !content) return;

  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    const res = await api.proxyGet('/profile');
    const profile = res.data || res;
    renderProfileAccordion(profile, content);
    loadedProfile = profile;
    content.style.display = 'block';
    btn.textContent = 'Refresh Profile Data';
  } catch (err) {
    content.style.display = 'block';
    content.innerHTML = `<div class="psycle-card-error">Failed to load profile: ${err.message}</div>`;
    btn.textContent = 'Retry';
  } finally {
    btn.disabled = false;
  }
}

// Konami code sequence: ↑↑↓↓←→←→BA
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
let konamiProgress = 0;
let konamiUnlocked = false;

function setupKonamiListener() {
  if (document.body.dataset.konamiListenerAttached) return;
  document.body.dataset.konamiListenerAttached = 'true';
  document.addEventListener('keydown', (e) => {
    if (e.key === KONAMI[konamiProgress]) {
      konamiProgress++;
      if (konamiProgress === KONAMI.length) {
        konamiProgress = 0;
        if (loadedProfile) {
          openProfileEditorModal(loadedProfile);
        } else {
          api.proxyGet('/profile').then(res => {
            loadedProfile = res.data || res;
            openProfileEditorModal(loadedProfile);
          }).catch(() => showToast('Could not load profile', 'error'));
        }
      }
    } else {
      konamiProgress = e.key === KONAMI[0] ? 1 : 0;
    }
  });
}

// ─── Profile Editor Modal (Konami-triggered) ────────────────────────────────

function openProfileEditorModal(profile) {
  const modal = document.getElementById('psycle-profile-editor-modal');
  if (!modal) return;

  const body = document.getElementById('psycle-profile-editor-body');
  if (!body) return;

  modal.style.display = 'flex';
  body.innerHTML = '';
  renderProfileEditorBody(profile, body, modal);
}

function renderProfileEditorBody(profile, body, modal) {
  const originalProfile = JSON.parse(JSON.stringify(profile));

  function getByPath(obj, path) {
    return path.split('.').reduce((acc, part) => acc && acc[part] !== undefined ? acc[part] : undefined, obj);
  }

  function setByPath(obj, path, value) {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
  }

  function humanizeKey(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  function isBool(path) {
    const boolPaths = ['verified', 'has_purchased', 'metafields.extended_booking_allowed', 'metafields.opt_in_email', 'metafields.opt_in_sms', 'metafields.vip'];
    return boolPaths.includes(path);
  }

  const sections = [
    {
      title: '👤 Basic Info',
      fields: [
        { key: 'first_name', path: 'first_name' },
        { key: 'last_name', path: 'last_name' },
        { key: 'email', path: 'email' },
        { key: 'username', path: 'username' },
        { key: 'dob', path: 'dob' },
        { key: 'telephone', path: 'telephone' },
        { key: 'verified', path: 'verified' },
      ]
    },
    {
      title: '💳 Account & Payments',
      fields: [
        { key: 'stripe_id', path: 'stripe_id' },
        { key: 'card_brand', path: 'card_brand' },
        { key: 'card_last_four', path: 'card_last_four' },
        { key: 'has_purchased', path: 'has_purchased' },
      ]
    },
    {
      title: '⚙️ Metafields & Preferences',
      fields: [
        { key: 'vip', path: 'metafields.vip' },
        { key: 'gender', path: 'metafields.gender' },
        { key: 'address_1', path: 'metafields.address_1' },
        { key: 'address_2', path: 'metafields.address_2' },
        { key: 'address_3', path: 'metafields.address_3' },
        { key: 'address_postcode', path: 'metafields.address_postcode' },
        { key: 'shoe_size', path: 'metafields.shoe_size' },
        { key: 'seat_height', path: 'metafields.seat_height' },
        { key: 'seat_horizontal', path: 'metafields.seat_horizontal' },
        { key: 'handlebar_height', path: 'metafields.handlebar_height' },
        { key: 'handlebar_horizontal', path: 'metafields.handlebar_horizontal' },
        { key: 'emergency_contact_name', path: 'metafields.emergency_contact_name' },
        { key: 'emergency_contact_mobile', path: 'metafields.emergency_contact_mobile' },
        { key: 'emergency_contact_relationship', path: 'metafields.emergency_contact_relationship' },
        { key: 'booking_period', path: 'metafields.booking_period' },
        { key: 'extended_booking_allowed', path: 'metafields.extended_booking_allowed' },
        { key: 'opt_in_email', path: 'metafields.opt_in_email' },
        { key: 'opt_in_sms', path: 'metafields.opt_in_sms' },
      ]
    },
    {
      title: '📊 Booking Stats & Cutoffs',
      fields: [
        { key: 'total_bookings', path: 'stats.total_bookings' },
        { key: 'total_unique_bookings', path: 'stats.total_unique_bookings' },
        { key: 'total_unique_bookings_attended', path: 'stats.total_unique_bookings_attended' },
        { key: 'credits_remaining', path: 'stats.credits_remaining' },
        { key: 'total_attended_minutes', path: 'stats.total_attended_minutes' },
        { key: 'booking_cutoff', path: 'booking_cutoff' },
        { key: 'extended_cutoff', path: 'extended_cutoff' },
      ]
    },
  ];

  let changeLog = [];

  function renderLog() {
    const logContainer = document.getElementById('psycle-editor-log-container');
    if (!logContainer) return;
    if (changeLog.length === 0) {
      logContainer.innerHTML = '<div style="padding:12px;text-align:center;color:#64748b;font-style:italic;font-size:12px;">No changes yet.</div>';
      return;
    }
    const reversed = [...changeLog].reverse();
    logContainer.innerHTML = reversed.map(e => {
      const ts = e.timestamp.toLocaleTimeString('en-GB', { hour12: false });
      const oldS = e.oldValue == null ? 'null' : String(e.oldValue);
      const newS = e.newValue == null ? 'null' : String(e.newValue);
      const icon = e.status === 'verified' ? '✅' : e.status === 'sent' ? '⚠️' : e.status === 'failed' ? '❌' : '🔙';
      const color = e.status === 'verified' ? '#34d399' : e.status === 'sent' ? '#fbbf24' : e.status === 'failed' ? '#f87171' : '#94a3b8';
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,0.04);font-size:11px;">
        <span style="color:#64748b;flex-shrink:0;">${ts}</span>
        <span style="color:#c084fc;flex-shrink:0;">${e.fieldPath}</span>
        <span style="color:#94a3b8;flex:1;">${oldS} → <span style="color:#e2e8f0;">${newS}</span></span>
        <span style="color:${color};">${icon}</span>
      </div>`;
    }).join('');
  }

  // Build sections
  sections.forEach((section, sIdx) => {
    const sectionDiv = document.createElement('div');
    sectionDiv.style.cssText = 'margin-bottom:8px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.04);font-weight:600;font-size:13px;color:#e2e8f0;';
    const chevron = document.createElement('span');
    chevron.style.cssText = 'transition:transform 0.2s;';
    chevron.textContent = '▼';
    hdr.innerHTML = `<span>${section.title}</span>`;
    hdr.appendChild(chevron);

    const sectionBody = document.createElement('div');
    sectionBody.style.cssText = 'padding:10px 14px;display:none;';

    section.fields.forEach(({ key, path }) => {
      const rawVal = getByPath(profile, path);
      const isCheckbox = isBool(path);
      const fieldRow = document.createElement('div');
      fieldRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;';

      const label = document.createElement('span');
      label.style.cssText = 'flex:0 0 180px;color:#94a3b8;';
      label.textContent = humanizeKey(key);

      let input;
      if (isCheckbox) {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!rawVal;
        input.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:#a78bfa;';
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = rawVal == null ? '' : String(rawVal);
        input.placeholder = rawVal == null ? 'null' : '';
        input.style.cssText = 'flex:1;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);border-radius:5px;padding:4px 8px;font-size:11px;color:#e2e8f0;font-family:inherit;';
      }

      const saveBtn = document.createElement('button');
      saveBtn.textContent = '💾 Save';
      saveBtn.style.cssText = 'display:none;padding:3px 10px;font-size:10px;background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);border-radius:5px;color:#a78bfa;cursor:pointer;white-space:nowrap;';

      const checkChanged = () => {
        const origVal = getByPath(originalProfile, path);
        let currentVal = isCheckbox ? input.checked : input.value;
        const origStr = origVal == null ? '' : String(origVal);
        const currStr = currentVal === null || currentVal === undefined ? '' : String(currentVal);
        saveBtn.style.display = origStr !== currStr ? 'inline-block' : 'none';
      };

      input.addEventListener('input', checkChanged);
      input.addEventListener('change', checkChanged);

      saveBtn.addEventListener('click', async () => {
        const origVal = getByPath(originalProfile, path);
        let newVal = isCheckbox ? input.checked : input.value;
        if (!isCheckbox) {
          const raw = input.value;
          if (raw === '' && input.placeholder === 'null') newVal = null;
          else {
            const num = Number(raw);
            if (!isNaN(num) && raw.trim() !== '') newVal = num;
          }
        }

        saveBtn.disabled = true;
        saveBtn.textContent = '⏳';

        const workingProfile = JSON.parse(JSON.stringify(profile));
        setByPath(workingProfile, path, newVal);

        let logEntry = {
          timestamp: new Date(),
          fieldPath: path,
          oldValue: origVal,
          newValue: newVal,
          status: 'sent'
        };
        changeLog.push(logEntry);
        renderLog();

        try {
          await api.proxyPut('/profile', workingProfile);
          // Re-fetch to verify
          const refetched = await api.proxyGet('/profile');
          const refetchedProfile = refetched.data || refetched;
          const verifiedVal = getByPath(refetchedProfile, path);
          const verifiedStr = verifiedVal == null ? '' : String(verifiedVal);
          const newStr = newVal == null ? '' : String(newVal);
          if (verifiedStr === newStr) {
            logEntry.status = 'verified';
            setByPath(profile, path, newVal);
            setByPath(originalProfile, path, newVal);
            loadedProfile = profile;
          } else {
            logEntry.status = 'reverted';
            // Revert UI
            if (isCheckbox) input.checked = !!origVal;
            else input.value = origVal == null ? '' : String(origVal);
          }
        } catch (err) {
          logEntry.status = 'failed';
          showToast(`Save failed: ${err.message}`, 'error');
        }

        renderLog();
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save';
        checkChanged();
      });

      fieldRow.appendChild(label);
      if (isCheckbox) {
        const wrap = document.createElement('span');
        wrap.style.cssText = 'flex:1;display:flex;align-items:center;gap:8px;';
        wrap.appendChild(input);
        fieldRow.appendChild(wrap);
      } else {
        fieldRow.appendChild(input);
      }
      fieldRow.appendChild(saveBtn);
      sectionBody.appendChild(fieldRow);
    });

    hdr.addEventListener('click', () => {
      const isOpen = sectionBody.style.display !== 'none';
      sectionBody.style.display = isOpen ? 'none' : 'block';
      chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
    });

    sectionDiv.appendChild(hdr);
    sectionDiv.appendChild(sectionBody);
    body.appendChild(sectionDiv);
  });

  // Change log panel
  const logPanel = document.createElement('div');
  logPanel.style.cssText = 'margin-top:12px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;';
  const logHdr = document.createElement('div');
  logHdr.style.cssText = 'padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.04);font-weight:600;font-size:13px;color:#e2e8f0;';
  const logChevron = document.createElement('span');
  logChevron.textContent = '▼';
  logChevron.style.cssText = 'transition:transform 0.2s;transform:rotate(180deg);';
  logHdr.innerHTML = '<span>📋 Change Log</span>';
  logHdr.appendChild(logChevron);

  const logBody = document.createElement('div');
  logBody.id = 'psycle-editor-log-container';
  logBody.style.cssText = 'max-height:200px;overflow-y:auto;';
  logBody.innerHTML = '<div style="padding:12px;text-align:center;color:#64748b;font-style:italic;font-size:12px;">No changes yet.</div>';

  logHdr.addEventListener('click', () => {
    const isOpen = logBody.style.display !== 'none';
    logBody.style.display = isOpen ? 'none' : 'block';
    logChevron.style.transform = isOpen ? '' : 'rotate(180deg)';
  });

  logPanel.appendChild(logHdr);
  logPanel.appendChild(logBody);
  body.appendChild(logPanel);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'psycle-btn';
  closeBtn.style.cssText = 'width:100%;margin-top:12px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);color:#e2e8f0;';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  body.appendChild(closeBtn);
}

function renderProfileAccordion(profile, container) {
  setupKonamiListener();

  container.innerHTML = '';

  // Render each top-level key as a collapsible section showing raw values
  const topLevelKeys = Object.keys(profile);

  topLevelKeys.forEach(key => {
    const value = profile[key];
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'psycle-profile-section';
    sectionDiv.style.cssText = 'margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; overflow: hidden;';

    const header = document.createElement('div');
    header.style.cssText = 'padding: 10px 14px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.04); font-weight: 600; font-size: 13px; color: #e2e8f0;';

    const isObject = value !== null && typeof value === 'object';
    const preview = isObject ? (Array.isArray(value) ? `[${value.length}]` : '{…}') : String(value ?? 'null');
    header.innerHTML = `<span style="color:#a78bfa;">${key}</span><span style="color:#94a3b8;font-size:11px;font-weight:400;">${isObject ? '' : preview}<span class="psycle-profile-chevron" style="margin-left:8px;transition:transform 0.2s;">▼</span></span>`;

    const body = document.createElement('div');
    body.style.cssText = 'padding: 10px 14px; display: none;';

    if (isObject) {
      const pre = document.createElement('pre');
      pre.style.cssText = 'background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:10px;font-size:11px;line-height:1.5;color:#e2e8f0;white-space:pre-wrap;word-break:break-all;margin:0;overflow:auto;max-height:300px;';
      pre.textContent = JSON.stringify(value, null, 2);
      body.appendChild(pre);
    } else {
      const row = document.createElement('div');
      row.style.cssText = 'font-size: 12px; color: #e2e8f0; word-break: break-word; font-family: monospace;';
      row.textContent = String(value ?? 'null');
      body.appendChild(row);
    }

    header.addEventListener('click', () => {
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      header.querySelector('.psycle-profile-chevron').style.transform = isOpen ? '' : 'rotate(180deg)';
    });

    sectionDiv.appendChild(header);
    sectionDiv.appendChild(body);
    container.appendChild(sectionDiv);
  });

  // Developer mode section (Konami-unlocked)
  const devSection = document.createElement('div');
  devSection.className = 'psycle-dev-mode-section';
  devSection.style.cssText = `display: ${konamiUnlocked ? 'block' : 'none'}; margin-top: 12px;`;

  // Metafield editor
  const publicMeta = profile.metafields?.public || {};
  const editableKeys = Object.keys(publicMeta).filter(k => k !== 'bookmarks');
  const metaEditorRows = editableKeys.map(key => {
    const val = typeof publicMeta[key] === 'object' ? JSON.stringify(publicMeta[key]) : String(publicMeta[key] ?? '');
    return `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
        <span style="flex:0 0 120px;font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;" title="${key}">${key}</span>
        <input data-metakey="${key}" value="${val.replace(/"/g, '&quot;')}" style="flex:1;background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.12);border-radius:5px;padding:4px 8px;font-size:11px;color:#e2e8f0;font-family:inherit;" />
      </div>`;
  }).join('');

  const rawJson = JSON.stringify(profile, null, 2).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  devSection.innerHTML = `
    <div style="border: 1px solid rgba(245,158,11,0.3); border-radius: 8px; overflow: hidden;">
      <div style="padding: 10px 14px; background: rgba(245,158,11,0.08); font-weight: 600; font-size: 13px; color: #fbbf24;">
        🔓 Developer Mode
      </div>
      <div style="padding: 12px 14px;">
        ${editableKeys.length > 0 ? `
          <div style="margin-bottom:14px;">
            <div style="font-size:11px;font-weight:600;color:#fbbf24;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Edit Public Metafields</div>
            ${metaEditorRows}
            <button id="psycle-metafields-save-btn" class="psycle-btn-mini" style="margin-top:6px;background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.3);color:#fbbf24;">Save Metafields</button>
          </div>
        ` : ''}
        <div style="font-size:11px;font-weight:600;color:#fbbf24;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Raw Profile JSON</div>
        <pre style="background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 12px; font-size: 10px; line-height: 1.5; color: #e2e8f0; max-height: 400px; overflow: auto; white-space: pre-wrap; word-break: break-all; margin: 0;">${rawJson}</pre>
        <div style="margin-top: 8px; font-size: 11px; color: #94a3b8;">Press ↑↑↓↓←→←→BA again to hide.</div>
      </div>
    </div>
  `;

  if (editableKeys.length > 0) {
    devSection.querySelector('#psycle-metafields-save-btn').addEventListener('click', async () => {
      const saveBtn = devSection.querySelector('#psycle-metafields-save-btn');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const inputs = devSection.querySelectorAll('input[data-metakey]');
        const updates = {};
        inputs.forEach(inp => {
          const k = inp.dataset.metakey;
          let v = inp.value;
          try { v = JSON.parse(v); } catch (_) { /* keep as string */ }
          updates[k] = v;
        });
        // CodexFit metafields endpoint: PATCH /profile with metafields body
        await api.proxyPut('/profile', { metafields: { public: { ...publicMeta, ...updates } } });
        showToast('Metafields saved!', 'success');
      } catch (err) {
        showToast(`Save failed: ${err.message}`, 'error');
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Metafields';
      }
    });
  }

  container.appendChild(devSection);

  // Auto-expand first section
  const firstBody = container.querySelector('.psycle-profile-section div:last-child');
  const firstSec = container.querySelector('.psycle-profile-section');
  if (firstSec) {
    const b = firstSec.querySelector('div:last-child');
    if (b) b.style.display = 'block';
    const ch = firstSec.querySelector('.psycle-profile-chevron');
    if (ch) ch.style.transform = 'rotate(180deg)';
  }
}

async function openManageSpotMapsModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#0f172a;border:1px solid rgba(255,255,255,0.12);border-radius:16px;width:100%;max-width:500px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;';
  header.innerHTML = `<h3 style="margin:0;font-size:16px;font-weight:700;color:#f1f5f9;">Preferred Spot Maps</h3><button style="background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;padding:0;line-height:1;" id="manage-modal-close">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';
  body.innerHTML = '<div style="text-align:center;padding:24px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:#94a3b8;margin-top:10px;font-size:13px;">Loading studios…</div></div>';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  header.querySelector('#manage-modal-close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  try {
    const [prefs, studiosRes] = await Promise.all([
      api.getStudioPreferences(),
      cache.studios?.length > 0 ? Promise.resolve(cache.studios) : api.proxyGet('/studios').then(r => {
        const s = r.data || r || [];
        cache.studios = s;
        return s;
      })
    ]);

    let locations = cache.locations || [];
    if (!locations.length) {
      try {
        const locRes = await api.proxyGet('/locations');
        locations = locRes.data || locRes || [];
        cache.locations = locations;
      } catch (e) {
        locations = [];
      }
    }

    const studios = studiosRes || cache.studios || [];
    renderManageSpotMapsModal(prefs, studios, locations, body, close);
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error" style="padding:16px;">Error loading studios: ${err.message}</div>`;
  }
}

function renderManageSpotMapsModal(prefs, studios, locations, container, onClose) {
  const locMap = {};
  locations.forEach(loc => { locMap[loc.id] = loc.name; });

  // Determine which studio IDs appear in the loaded timetable events
  const activeStudioIds = new Set();
  if (cache.events && cache.events.length > 0) {
    cache.events.forEach(ev => { if (ev.studio_id) activeStudioIds.add(ev.studio_id); });
  }
  const hasActiveFilter = activeStudioIds.size > 0;

  const grouped = {};
  studios.forEach(studio => {
    if (!studio.layout?.slots || studio.layout.slots.length === 0) return; // only studios with layouts
    if (hasActiveFilter && !activeStudioIds.has(studio.id)) return; // only studios with active classes
    const locName = locMap[studio.location_id] || 'Unknown Location';
    if (!grouped[locName]) grouped[locName] = [];
    grouped[locName].push(studio);
  });

  const sortedLocs = Object.keys(grouped).sort();
  container.innerHTML = '';

  if (sortedLocs.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:24px;color:#94a3b8;"><div style="font-size:32px;margin-bottom:12px;">🗺️</div><p style="margin:0;">No Studios Loaded</p><p style="font-size:12px;margin:8px 0 0 0;">Please refresh the timetable first to load the active locations and studios.</p></div>';
    return;
  }

  sortedLocs.forEach((locName, locIdx) => {
    const locSection = document.createElement('div');
    locSection.style.cssText = 'margin-bottom:14px;';

    const locHeader = document.createElement('div');
    locHeader.style.cssText = 'font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;padding:8px 0 6px 0;cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center;';
    const chevron = document.createElement('span');
    chevron.textContent = '▼';
    chevron.style.cssText = 'transition:transform 0.2s;';
    locHeader.innerHTML = `<span>${locName}</span>`;
    locHeader.appendChild(chevron);

    const studioList = document.createElement('div');
    studioList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    grouped[locName].forEach(studio => {
      const studioPrefs = prefs[studio.id];
      const hasPrefs = studioPrefs && (studioPrefs.preferredSlots?.length > 0 || studioPrefs.preferredRows?.length > 0);

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:8px;';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;';

      const name = document.createElement('div');
      name.style.cssText = 'font-size:13px;font-weight:500;color:#e2e8f0;';
      name.textContent = studio.name;
      info.appendChild(name);

      if (hasPrefs) {
        const detail = document.createElement('div');
        detail.style.cssText = 'font-size:11px;color:#64748b;margin-top:2px;';
        const parts = [];
        if (studioPrefs.preferredSlots?.length > 0) parts.push(`${studioPrefs.preferredSlots.length} preferred spot${studioPrefs.preferredSlots.length > 1 ? 's' : ''}`);
        if (studioPrefs.preferredRows?.length > 0) parts.push(`${studioPrefs.preferredRows.length} preferred row${studioPrefs.preferredRows.length > 1 ? 's' : ''}`);
        detail.textContent = parts.join(' · ');
        info.appendChild(detail);
      }
      row.appendChild(info);

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;';

      const editBtn = document.createElement('button');
      editBtn.className = 'psycle-btn-mini';
      editBtn.style.cssText = 'font-size:11px;padding:4px 10px;';
      editBtn.textContent = hasPrefs ? 'Edit Spots' : 'Choose Spots';
      editBtn.addEventListener('click', () => openStudioFloorPlanEditor(studio.id, studio.name, () => openManageSpotMapsModal()));
      btns.appendChild(editBtn);

      if (hasPrefs) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'psycle-btn-mini';
        removeBtn.style.cssText = 'font-size:11px;padding:4px 10px;background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.25);color:#f87171;';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
          if (!confirm('Confirm remove?')) return;
          removeBtn.disabled = true;
          removeBtn.textContent = '…';
          try {
            await api.updateStudioPreferences(studio.id, { preferredSlots: [], preferredRows: [] });
            showToast(`Studio defaults removed!`, 'success');
            openManageSpotMapsModal();
          } catch (err) {
            showToast(`Failed: ${err.message}`, 'error');
            removeBtn.disabled = false;
            removeBtn.textContent = 'Remove';
          }
        });
        btns.appendChild(removeBtn);
      }

      row.appendChild(btns);
      studioList.appendChild(row);
    });

    // Collapsible toggle
    const isOpen = locIdx === 0; // First location open by default
    studioList.style.display = isOpen ? 'flex' : 'none';
    if (!isOpen) chevron.style.transform = 'rotate(-90deg)';

    locHeader.addEventListener('click', () => {
      const shown = studioList.style.display !== 'none';
      studioList.style.display = shown ? 'none' : 'flex';
      chevron.style.transform = shown ? 'rotate(-90deg)' : '';
    });

    locSection.appendChild(locHeader);
    locSection.appendChild(studioList);
    container.appendChild(locSection);
  });
}


async function openStudioFloorPlanEditor(studioId, studioName, onSaved) {
  // Build modal overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#0f172a;border:1px solid rgba(255,255,255,0.12);border-radius:16px;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;';
  header.innerHTML = `<div><div style="font-size:15px;font-weight:700;color:#f1f5f9;">Spot Map</div><div style="font-size:12px;color:#64748b;margin-top:2px;">${studioName}</div></div><button style="background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer;padding:0;line-height:1;" id="spot-editor-close">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';
  body.innerHTML = '<div style="text-align:center;padding:24px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:#94a3b8;margin-top:10px;font-size:13px;">Loading floor plan…</div></div>';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  header.querySelector('#spot-editor-close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  try {
    const [studioRes, allPrefs] = await Promise.all([
      api.proxyGet(`/studios/${studioId}`),
      api.getStudioPreferences()
    ]);

    const studio = studioRes.data || studioRes;
    const layoutSlots = studio?.layout?.slots || [];
    const existing = allPrefs[studioId] || {};

    const onSave = async (slots, rows) => {
      try {
        await api.updateStudioPreferences(studioId, { preferredSlots: slots, preferredRows: rows });
        showToast(`Saved spot map for ${studioName}`, 'success');
        close();
        if (onSaved) onSaved();
      } catch (err) {
        showToast(`Save failed: ${err.message}`, 'error');
      }
    };

    if (layoutSlots.length === 0) {
      body.innerHTML = `
        <div style="padding:20px;text-align:center;color:#94a3b8;">
          <div style="font-size:32px;margin-bottom:12px;">🗺️</div>
          <p style="margin:0 0 8px;color:#e2e8f0;font-weight:500;">No floor map available</p>
          <p style="font-size:12px;margin:0 0 20px;">Preferences will apply to any available spot when booking at this studio.</p>
          <button class="psycle-btn" id="spot-save-any" style="background:#a78bfa;color:#fff;">Save (Any Spot Preference)</button>
        </div>
      `;
      body.querySelector('#spot-save-any').onclick = () => onSave([], existing.preferredRows || []);
      return;
    }

    renderStudioFloorPlan(body, layoutSlots, existing.preferredSlots || [], existing.preferredRows || [], onSave, {
      bannerHtml: `<div style="font-size:11px;color:#a5b4fc;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.18);border-radius:8px;padding:8px 10px;margin-bottom:12px;line-height:1.5;">This is the one shared preferred spot map for <strong>${studioName}</strong>. Quick-Book, Auto-Book, and Auto-Upgrade at this studio all use it — changes apply everywhere.</div>`
    });
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error" style="padding:16px;">Error loading floor plan: ${err.message}</div>`;
  }
}

export async function initSettings() {
  loadSettingsInputs();
  setupSettingsListeners();
  setupKonamiListener();
  updatePushStatusUI();
  // Spot Maps section is ready; button opens the modal
}

function loadSettingsInputs() {
  const advBooking = document.getElementById('psycle-setting-advanced-booking');
  const upgradeEnabled = document.getElementById('psycle-setting-autoupgrade-enabled');
  const upgradeDefault = document.getElementById('psycle-setting-autoupgrade-default');
  const upgradeInterval = document.getElementById('psycle-setting-autoupgrade-interval');
  const debugMode = document.getElementById('psycle-setting-debug-mode');
  const prefetchWeeks = document.getElementById('psycle-setting-prefetch-weeks');

  if (advBooking) advBooking.checked = !!userSettings.advancedBooking;
  if (upgradeEnabled) upgradeEnabled.checked = userSettings.autoUpgradeEnabled !== false;
  if (upgradeDefault) upgradeDefault.checked = !!userSettings.autoUpgradeByDefault;
  if (upgradeInterval) upgradeInterval.value = userSettings.autoUpgradeInterval || '15min';
  if (debugMode) debugMode.checked = !!userSettings.debugMode;
  if (prefetchWeeks) prefetchWeeks.value = String(userSettings.prefetchWeeks || 4);
}

function setupSettingsListeners() {
  const advBooking = document.getElementById('psycle-setting-advanced-booking');
  const upgradeEnabled = document.getElementById('psycle-setting-autoupgrade-enabled');
  const upgradeDefault = document.getElementById('psycle-setting-autoupgrade-default');
  const upgradeInterval = document.getElementById('psycle-setting-autoupgrade-interval');
  const debugMode = document.getElementById('psycle-setting-debug-mode');
  const prefetchWeeks = document.getElementById('psycle-setting-prefetch-weeks');

  const saveSettings = async () => {
    const newSettings = {
      advancedBooking: advBooking ? advBooking.checked : false,
      autoUpgradeEnabled: upgradeEnabled ? upgradeEnabled.checked : true,
      autoUpgradeByDefault: upgradeDefault ? upgradeDefault.checked : false,
      autoUpgradeInterval: upgradeInterval ? upgradeInterval.value : '15min',
      debugMode: debugMode ? debugMode.checked : false,
      prefetchWeeks: prefetchWeeks ? parseInt(prefetchWeeks.value) : 4
    };

    try {
      await api.updateSettings(newSettings);
      Object.assign(userSettings, newSettings);
      showToast('Settings saved successfully.', 'success');
    } catch (err) {
      showToast(`Error saving settings: ${err.message}`, 'error');
    }
  };

  if (advBooking && !advBooking.dataset.listener) {
    advBooking.dataset.listener = 'true';
    advBooking.addEventListener('change', saveSettings);
  }
  if (upgradeEnabled && !upgradeEnabled.dataset.listener) {
    upgradeEnabled.dataset.listener = 'true';
    upgradeEnabled.addEventListener('change', saveSettings);
  }
  if (upgradeDefault && !upgradeDefault.dataset.listener) {
    upgradeDefault.dataset.listener = 'true';
    upgradeDefault.addEventListener('change', saveSettings);
  }
  if (upgradeInterval && !upgradeInterval.dataset.listener) {
    upgradeInterval.dataset.listener = 'true';
    upgradeInterval.addEventListener('change', saveSettings);
  }
  if (debugMode && !debugMode.dataset.listener) {
    debugMode.dataset.listener = 'true';
    debugMode.addEventListener('change', saveSettings);
  }
  if (prefetchWeeks && !prefetchWeeks.dataset.listener) {
    prefetchWeeks.dataset.listener = 'true';
    prefetchWeeks.addEventListener('change', saveSettings);
  }

  // Push notification toggle button
  const pushBtn = document.getElementById('psycle-push-toggle-btn');
  if (pushBtn && !pushBtn.dataset.listener) {
    pushBtn.dataset.listener = 'true';
    pushBtn.addEventListener('click', togglePushSubscription);
  }

  // Export config button
  const exportBtn = document.getElementById('psycle-settings-export-btn');
  if (exportBtn && !exportBtn.dataset.listener) {
    exportBtn.dataset.listener = 'true';
    exportBtn.addEventListener('click', async () => {
      try {
        showToast('Preparing config export...', 'info');
        const config = await api.exportConfig();
        
        // Trigger browser file download
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'psycle-preferences-backup.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        showToast('Config exported successfully!', 'success');
      } catch (err) {
        showToast(`Export failed: ${err.message}`, 'error');
      }
    });
  }

  // Import config file triggers
  const importBtn = document.getElementById('psycle-settings-import-btn');
  const importFileInput = document.getElementById('psycle-settings-import-file');

  if (importBtn && importFileInput && !importBtn.dataset.listener) {
    importBtn.dataset.listener = 'true';
    importBtn.addEventListener('click', () => {
      importFileInput.click();
    });

    importFileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const config = JSON.parse(event.target.result);
          
          showToast('Importing configuration...', 'info');
          await api.importConfig(config);
          showToast('Config imported successfully! Reloading data...', 'success');
          
          // Clear file input
          importFileInput.value = '';
          
          // Reload settings and update UI
          setTimeout(() => {
            window.location.reload();
          }, 1200);

        } catch (err) {
          showToast(`Import failed: Invalid JSON or format. ${err.message}`, 'error');
        }
      };
      reader.readAsText(file);
    });
  }

  // Profile explorer button
  const profileBtn = document.getElementById('psycle-profile-load-btn');
  if (profileBtn && !profileBtn.dataset.listener) {
    profileBtn.dataset.listener = 'true';
    profileBtn.addEventListener('click', loadProfileData);
  }

  // Profile editor modal close
  const profileEditorModal = document.getElementById('psycle-profile-editor-modal');
  const profileEditorClose = document.getElementById('psycle-profile-editor-modal-close');
  if (profileEditorModal && profileEditorClose && !profileEditorClose.dataset.listener) {
    profileEditorClose.dataset.listener = 'true';
    profileEditorClose.addEventListener('click', () => { profileEditorModal.style.display = 'none'; });
    profileEditorModal.querySelector('.psycle-modal-overlay').addEventListener('click', () => { profileEditorModal.style.display = 'none'; });
  }

  // Spot maps button
  const spotMapsBtn = document.getElementById('psycle-spotmaps-load-btn');
  if (spotMapsBtn && !spotMapsBtn.dataset.listener) {
    spotMapsBtn.dataset.listener = 'true';
    spotMapsBtn.addEventListener('click', openManageSpotMapsModal);
  }

  // Logout button
  const logoutBtn = document.getElementById('psycle-logout-btn');
  if (logoutBtn && !logoutBtn.dataset.listener) {
    logoutBtn.dataset.listener = 'true';
    logoutBtn.addEventListener('click', () => {
      showToast('Logging out...', 'info');
      localStorage.removeItem('psycleLocalToken');
      setTimeout(() => { window.location.reload(); }, 500);
    });
  }

  // Delete all data button (two-step confirm)
  const deleteDataBtn = document.getElementById('psycle-delete-data-btn');
  if (deleteDataBtn && !deleteDataBtn.dataset.listener) {
    deleteDataBtn.dataset.listener = 'true';
    deleteDataBtn.addEventListener('click', async () => {
      if (deleteDataBtn.dataset.confirmState !== 'confirm') {
        deleteDataBtn.dataset.confirmState = 'confirm';
        deleteDataBtn.textContent = 'Are you sure? Click again to confirm.';
        deleteDataBtn.style.background = '#ef4444';
        deleteDataBtn.style.color = '#fff';
        deleteDataBtn.style.borderColor = '#ef4444';
        setTimeout(() => {
          if (deleteDataBtn.dataset.confirmState === 'confirm') {
            delete deleteDataBtn.dataset.confirmState;
            deleteDataBtn.textContent = 'Delete All My Data';
            deleteDataBtn.style.background = '';
            deleteDataBtn.style.color = '';
            deleteDataBtn.style.borderColor = '';
          }
        }, 5000);
        return;
      }
      delete deleteDataBtn.dataset.confirmState;
      deleteDataBtn.disabled = true;
      deleteDataBtn.textContent = 'Deleting...';
      try {
        await apiFetch('/api/auth/me', { method: 'DELETE' });
        showToast('All data deleted. Logging out.', 'success');
        localStorage.removeItem('psycleLocalToken');
        setTimeout(() => { window.location.reload(); }, 1500);
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error');
        deleteDataBtn.disabled = false;
        deleteDataBtn.textContent = 'Delete All My Data';
      }
    });
  }
}
