import { api, apiFetch } from '../api';
import { showToast, togglePushSubscription, updatePushStatusUI, userSettings, cache, getTheme, setTheme } from '../main';
import { getBookingOffset, describeBookingWindow } from '../lib';
import { renderStudioFloorPlan } from './spotmap';
import { cacheGet } from './timetable';
import { clearApiCache } from '../cache.js';

let loadedProfile = null;

// ─── Profile Explorer — Unified Implementation ─────────────────────────────

let editMode = false;
let konamiProgress = 0;
let explorerModalOpen = false;
let changeLog = []; // module-level — persists across saves, reset on modal open

// Konami code sequence: ↑↑↓↓←→←→BA + Enter (uses e.code)
const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','KeyB','KeyA','Enter'];

// Section schema definition — categorizes known fields
const SECTION_DEFS = [
  {
    title: 'Basic Info',
    emoji: '👤',
    paths: ['id', 'first_name', 'last_name', 'email', 'username', 'dob', 'telephone', 'referral_code', 'verified', 'created_at']
  },
  {
    title: 'Account & Payments',
    emoji: '💳',
    paths: ['stripe_id', 'card_brand', 'card_last_four', 'has_purchased', 'opt_ins', 'policies']
  },
  {
    title: 'Metafields & Preferences',
    emoji: '⚙️',
    // Special: all metafields.* except metafields.public.bookmarks
    // Built dynamically in buildSections()
  },
  {
    title: 'Booking Stats & Cutoffs',
    emoji: '📊',
    paths: ['stats.total_bookings', 'stats.total_unique_bookings', 'stats.total_unique_bookings_attended', 'stats.credits_remaining', 'stats.total_attended_minutes', 'booking_cutoff', 'extended_cutoff']
  },
  {
    title: 'Available Credits',
    emoji: '🎟️',
    paths: ['available_credits']  // array — rendered as cards, read-only
  },
  {
    title: 'Subscriptions & Plans',
    emoji: '🔄',
    paths: ['subscriptions', 'subscription_statuses']  // arrays — rendered as cards, read-only
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function isScalar(val) {
  return val === null || val === undefined || typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean';
}

function formatVal(val) {
  if (val === null || val === undefined) return '<span style="color:var(--text-tertiary);font-style:italic;">null</span>';
  if (typeof val === 'object') {
    return `<pre style="margin:0;background:var(--surface-inset);padding:6px;border-radius:6px;font-family:monospace;font-size:12px;white-space:pre-wrap;word-break:break-all;color:var(--text);text-align:left;">${JSON.stringify(val, null, 2)}</pre>`;
  }
  if (typeof val === 'boolean') {
    return val ? '<span style="color:var(--success);font-weight:700;">true</span>' : '<span style="color:var(--danger);font-weight:700;">false</span>';
  }
  return `<span style="color:var(--text);font-weight:600;">${String(val)}</span>`;
}

// ─── Special Section Renderers ──────────────────────────────────────────────

function renderCreditsHtml(credits) {
  if (!credits || credits.length === 0) return '<div style="color:var(--text-secondary);font-style:italic;text-align:center;font-size:12px;">No active credits.</div>';
  return credits.map(c => `
    <div style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent);border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="display:flex;flex-direction:column;gap:2px;">
        <strong style="color:var(--text);font-size:13px;">${c.credit_type?.name || 'Unknown'}</strong>
        <span style="font-size:12px;color:var(--text-secondary);">Handle: ${c.credit_type?.handle || '—'}</span>
      </div>
      <span style="background:var(--feat-autoupgrade);color:var(--on-accent);border-radius:12px;padding:4px 10px;font-size:12px;font-weight:700;box-shadow:0 2px 4px color-mix(in srgb, var(--feat-autoupgrade) 30%, transparent);border:1px solid color-mix(in srgb, var(--text) 10%, transparent);">${c.count} Left</span>
    </div>
  `).join('');
}

function renderSubsHtml(subs, statuses) {
  const allSubs = [...(subs || []), ...(statuses || [])];
  if (allSubs.length === 0) return '<div style="color:var(--text-secondary);font-style:italic;text-align:center;font-size:12px;">No subscription plans found.</div>';
  return allSubs.map(s => {
    const status = s.status || 'inactive';
    const isCancelled = status === 'cancelled';
    const statusBg = isCancelled ? 'color-mix(in srgb, var(--danger) 15%, transparent)' : 'color-mix(in srgb, var(--success) 15%, transparent)';
    const statusBorder = isCancelled ? 'color-mix(in srgb, var(--danger) 30%, transparent)' : 'color-mix(in srgb, var(--success) 30%, transparent)';
    const statusColor = isCancelled ? 'var(--danger)' : 'var(--success)';
    return `
      <div style="background:color-mix(in srgb, var(--text) 2%, transparent);border:1px solid color-mix(in srgb, var(--text) 6%, transparent);border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;">
        <div style="display:flex;flex-direction:column;gap:2px;flex:1;">
          <span style="font-weight:600;color:var(--text);font-size:12px;line-height:1.4;">${s.name || '—'}</span>
          <span style="font-size:12px;color:var(--text-secondary);">Plan: ${s.handle || '—'}</span>
        </div>
        <span style="background:${statusBg};border:1px solid ${statusBorder};color:${statusColor};border-radius:6px;padding:3px 8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${status}</span>
      </div>
    `;
  }).join('');
}

// ─── buildSections — Build categorized section array from profile ───────────

function buildSections(profile) {
  const consumedPaths = new Set();
  const sections = [];

  SECTION_DEFS.forEach(def => {
    if (def.title === 'Metafields & Preferences') {
      const subFields = [];
      const metafields = profile.metafields;
      if (metafields && typeof metafields === 'object') {
        Object.keys(metafields).forEach(key => {
          if (key === 'public' && typeof metafields.public === 'object') {
            Object.keys(metafields.public).forEach(subKey => {
              if (subKey === 'bookmarks') return;
              const path = `metafields.public.${subKey}`;
              consumedPaths.add(path);
              subFields.push({ key: subKey, path, value: getByPath(profile, path), editable: isScalar(metafields.public[subKey]) });
            });
          } else {
            const path = `metafields.${key}`;
            consumedPaths.add(path);
            subFields.push({ key, path, value: metafields[key], editable: isScalar(metafields[key]) });
          }
        });
      }
      sections.push({ title: def.title, emoji: def.emoji, fields: subFields, isSpecial: false });
    } else if (def.title === 'Available Credits' || def.title === 'Subscriptions & Plans') {
      def.paths.forEach(p => consumedPaths.add(p));
      const vals = def.paths.map(p => ({ path: p, value: getByPath(profile, p) }));
      sections.push({ title: def.title, emoji: def.emoji, fields: vals, isSpecial: true });
    } else {
      const subFields = [];
      def.paths.forEach(path => {
        consumedPaths.add(path);
        const val = getByPath(profile, path);
        subFields.push({ key: path.split('.').pop(), path, value: val, editable: isScalar(val) });
      });
      sections.push({ title: def.title, emoji: def.emoji, fields: subFields, isSpecial: false });
    }
  });

  // Build the "Other" section — top-level keys not consumed
  const otherFields = [];
  const topKeys = Object.keys(profile);
  topKeys.forEach(key => {
    if (key === 'metafields' || key === 'stats') {
      // Check sub-keys
      const subObj = profile[key];
      if (subObj && typeof subObj === 'object') {
        Object.keys(subObj).forEach(subKey => {
          const path = `${key}.${subKey}`;
          if (!consumedPaths.has(path)) {
            otherFields.push({ key: path, path, value: getByPath(profile, path), editable: isScalar(getByPath(profile, path)) });
          }
        });
      }
    } else {
      // Check if any path starting with this key is consumed
      const consumed = Array.from(consumedPaths).some(cp => cp === key || cp.startsWith(key + '.'));
      if (!consumed) {
        otherFields.push({ key, path: key, value: profile[key], editable: isScalar(profile[key]) });
      }
    }
  });

  if (otherFields.length > 0) {
    sections.push({ title: 'Other', emoji: '📦', fields: otherFields, isSpecial: false });
  }

  return sections;
}

// ─── Modal Functions ────────────────────────────────────────────────────────

async function openProfileExplorerModal() {
  const modal = document.getElementById('psycle-profile-explorer-modal');
  const body = document.getElementById('psycle-profile-explorer-body');
  if (!modal || !body) return;

  // Reset state
  editMode = false;
  konamiProgress = 0;
  explorerModalOpen = true;
  changeLog = [];

  // Show loading state — use .show class for opacity transition (matches booking/debug modal convention)
  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('show'), 10);
  body.innerHTML = '<div style="text-align:center;padding:40px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:var(--text-secondary);margin-top:10px;font-size:13px;">Loading profile…</div></div>';

  // Set up close handlers
  setupExplorerModalClose(modal);

  // Set up konami listener (scoped to modal open)
  setupExplorerKonamiListener();

  try {
    const res = await api.proxyGet('/profile', { ttlMs: 300000 });
    loadedProfile = res.data || res;
    renderExplorerBody(body);
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error">Unable to load profile data. Connect to the internet to sync. (${err.message})</div>`;
  }
}

function setupExplorerModalClose(modal) {
  const closeBtn = document.getElementById('psycle-profile-explorer-close');
  const overlay = modal.querySelector('.psycle-modal-overlay');
  const closer = () => {
    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
    explorerModalOpen = false;
    editMode = false;
    konamiProgress = 0;
  };
  if (closeBtn && !closeBtn.dataset.listener) {
    closeBtn.dataset.listener = 'true';
    closeBtn.addEventListener('click', closer);
  }
  if (overlay && !overlay.dataset.listener) {
    overlay.dataset.listener = 'true';
    overlay.addEventListener('click', closer);
  }
}

function setupExplorerKonamiListener() {
  if (document.body.dataset.explorerKonamiAttached) return;
  document.body.dataset.explorerKonamiAttached = 'true';
  document.addEventListener('keydown', (e) => {
    if (!explorerModalOpen) {
      konamiProgress = 0;
      return;
    }
    if (e.code === KONAMI[konamiProgress]) {
      konamiProgress++;
      if (konamiProgress === KONAMI.length) {
        konamiProgress = 0;
        toggleEditMode();
      }
    } else {
      konamiProgress = e.code === KONAMI[0] ? 1 : 0;
    }
  });
}

function toggleEditMode() {
  if (!loadedProfile) return;
  if (editMode) {
    // Exiting edit mode — check for unsaved changes
    const body = document.getElementById('psycle-profile-explorer-body');
    const hasChanges = body.querySelector('.psycle-profile-save-btn') && body.querySelector('.psycle-profile-save-btn').style.display !== 'none';
    if (hasChanges) {
      if (!confirm('You have unsaved changes. Exit edit mode and discard them?')) return;
    }
  }
  editMode = !editMode;
  const body = document.getElementById('psycle-profile-explorer-body');
  renderExplorerBody(body);
  if (editMode) {
    showToast('Edit mode enabled', 'info');
  } else {
    showToast('Edit mode disabled', 'info');
  }
}

// ─── Render Functions ───────────────────────────────────────────────────────

function renderExplorerBody(body) {
  if (!loadedProfile) {
    body.innerHTML = '<div class="psycle-card-error">No profile data loaded.</div>';
    return;
  }

  const sections = buildSections(loadedProfile);
  let html = '';

  // Edit mode banner
  if (editMode) {
    html += `<div style="background:color-mix(in srgb, var(--warning) 10%, transparent);border:1px solid color-mix(in srgb, var(--warning) 30%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--warning);font-weight:600;font-size:13px;">🔓 Edit Mode Enabled — modify fields and click Save Changes</span>
      <span style="color:var(--text-secondary);font-size:12px;">Enter konami code again to exit</span>
    </div>`;
  }

  // Render each section as an accordion
  sections.forEach((section, idx) => {
    const isSpecial = section.title === 'Available Credits' || section.title === 'Subscriptions & Plans';
    html += renderSectionAccordion(section, idx, isSpecial);
  });

  // Change log (only in edit mode)
  if (editMode) {
    const logEntriesHtml = renderLogEntriesHtml();
    html += `
      <div class="psycle-profile-log-panel" style="margin-top:12px;border:1px solid color-mix(in srgb, var(--text) 8%, transparent);border-radius:12px;overflow:hidden;">
        <div class="psycle-profile-section-header" id="psycle-explorer-log-header" style="background:color-mix(in srgb, var(--text) 3%, transparent);padding:10px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;">
          <span style="font-weight:700;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px;">📝 Change Log <span id="psycle-explorer-log-count" style="font-weight:400;font-size:12px;color:var(--text-secondary);">(${changeLog.length})</span></span>
          <span class="psycle-accordion-arrow" id="psycle-explorer-log-arrow" style="font-size:12px;color:var(--text-secondary);transition:transform 0.2s;">▲</span>
        </div>
        <div id="psycle-explorer-log-container" style="max-height:200px;overflow-y:auto;padding:8px;background:var(--surface-inset);border-top:1px solid color-mix(in srgb, var(--text) 5%, transparent);">
          ${logEntriesHtml}
        </div>
      </div>
    `;
    // Save Changes button
    html += `<button id="psycle-profile-save-btn" class="psycle-btn" style="width:100%;margin-top:12px;background:color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 40%, transparent);color:var(--feat-autoupgrade);font-weight:700;display:none;">💾 Save Changes</button>`;
  }

  body.innerHTML = html;

  // Attach accordion toggles
  body.querySelectorAll('.psycle-profile-section').forEach(sec => {
    const header = sec.querySelector('.psycle-profile-section-header');
    const content = sec.querySelector('.psycle-profile-section-content');
    const arrow = sec.querySelector('.psycle-accordion-arrow');
    if (header) {
      header.addEventListener('click', () => {
        const closed = content.style.display === 'none';
        content.style.display = closed ? 'block' : 'none';
        if (arrow) {
          arrow.style.transform = closed ? 'rotate(180deg)' : 'rotate(0deg)';
          arrow.textContent = closed ? '▲' : '▼';
        }
      });
    }
  });

  // Log toggle
  const logHeader = document.getElementById('psycle-explorer-log-header');
  if (logHeader) {
    const logContainer = document.getElementById('psycle-explorer-log-container');
    const logArrow = document.getElementById('psycle-explorer-log-arrow');
    logHeader.addEventListener('click', () => {
      const closed = logContainer.style.display === 'none';
      logContainer.style.display = closed ? 'block' : 'none';
      if (logArrow) {
        logArrow.style.transform = closed ? 'rotate(180deg)' : 'rotate(0deg)';
        logArrow.textContent = closed ? '▲' : '▼';
      }
    });
  }

  // In edit mode: attach input change listeners + save button
  if (editMode) {
    setupEditListeners(body);
  }
}

function renderSectionAccordion(section, idx, isSpecial) {
  let contentHtml = '';

  if (section.title === 'Available Credits') {
    contentHtml = renderCreditsHtml(getByPath(loadedProfile, 'available_credits'));
  } else if (section.title === 'Subscriptions & Plans') {
    contentHtml = renderSubsHtml(getByPath(loadedProfile, 'subscriptions'), getByPath(loadedProfile, 'subscription_statuses'));
  } else {
    // Regular key-value rows
    contentHtml = '<div style="display:flex;flex-direction:column;gap:8px;">';
    section.fields.forEach(field => {
      const label = humanizeKey(field.key);
      if (editMode && field.editable) {
        const isBool = typeof field.value === 'boolean';
        let inputHtml;
        if (isBool) {
          inputHtml = `<input type="checkbox" class="psycle-profile-edit-input" data-path="${field.path}" ${field.value ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;accent-color:var(--feat-autoupgrade);">`;
        } else {
          const val = field.value !== null && field.value !== undefined ? String(field.value) : '';
          inputHtml = `<input type="text" class="psycle-profile-edit-input" data-path="${field.path}" value="${val.replace(/"/g, '&quot;')}" placeholder="${field.value === null ? 'null' : ''}" style="flex:1;background:var(--surface-inset);border:1px solid color-mix(in srgb, var(--text) 10%, transparent);border-radius:5px;padding:4px 8px;font-size:12px;color:var(--text);font-family:inherit;">`;
        }
        contentHtml += `
          <div class="psycle-profile-field-row" data-path="${field.path}" style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed color-mix(in srgb, var(--text) 5%, transparent);">
            <span style="color:var(--text-secondary);font-size:12px;font-weight:500;flex:0 0 160px;">${label}</span>
            ${inputHtml}
          </div>
        `;
      } else {
        contentHtml += `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:1px dashed color-mix(in srgb, var(--text) 5%, transparent);padding-bottom:6px;">
            <span style="color:var(--text-secondary);font-size:12px;font-weight:500;padding-top:1px;">${label}</span>
            <div style="font-size:12px;text-align:right;max-width:65%;word-break:break-word;">${formatVal(field.value)}</div>
          </div>
        `;
      }
    });
    contentHtml += '</div>';
  }

  // For special sections in edit mode, add a read-only badge
  let titleSuffix = '';
  if (editMode && isSpecial) {
    titleSuffix = ' <span style="font-size:12px;color:var(--text-tertiary);font-weight:400;">(read-only)</span>';
  }

  return `
    <div class="psycle-profile-section" style="border:1px solid color-mix(in srgb, var(--text) 8%, transparent);border-radius:12px;overflow:hidden;flex-shrink:0;margin-bottom:10px;">
      <div class="psycle-profile-section-header" style="background:color-mix(in srgb, var(--text) 3%, transparent);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none;">
        <span style="font-weight:700;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px;">${section.emoji} ${section.title}${titleSuffix}</span>
        <span class="psycle-accordion-arrow" style="font-size:12px;color:var(--text-secondary);transition:transform 0.2s;">▼</span>
      </div>
      <div class="psycle-profile-section-content" style="display:none;padding:14px;background:var(--surface-inset);border-top:1px solid color-mix(in srgb, var(--text) 5%, transparent);">
        ${contentHtml}
      </div>
    </div>
  `;
}

function setupEditListeners(body) {
  const saveBtn = document.getElementById('psycle-profile-save-btn');
  if (!saveBtn) return;

  const originalProfile = JSON.parse(JSON.stringify(loadedProfile));

  const checkChanges = () => {
    let hasChanges = false;
    body.querySelectorAll('.psycle-profile-edit-input').forEach(input => {
      const path = input.getAttribute('data-path');
      const origVal = getByPath(originalProfile, path);
      let curVal;
      if (input.type === 'checkbox') {
        curVal = input.checked;
      } else {
        const raw = input.value;
        if (raw === '' && input.placeholder === 'null') curVal = null;
        else curVal = raw;
      }
      if (String(curVal) !== String(origVal)) {
        hasChanges = true;
      }
    });
    saveBtn.style.display = hasChanges ? 'block' : 'none';
  };

  body.querySelectorAll('.psycle-profile-edit-input').forEach(input => {
    input.addEventListener('input', checkChanges);
    input.addEventListener('change', checkChanges);
  });

  saveBtn.addEventListener('click', () => saveProfileChanges(body, originalProfile));
}

// Render log entries HTML from the module-level changeLog (used by renderExplorerBody and saveProfileChanges)
function renderLogEntriesHtml() {
  if (changeLog.length === 0) {
    return '<div style="padding:12px;text-align:center;color:var(--text-tertiary);font-style:italic;font-size:12px;">No changes yet.</div>';
  }
  const reversed = [...changeLog].reverse();
  return reversed.map(e => {
    const ts = e.timestamp.toLocaleTimeString('en-GB', { hour12: false });
    const oldS = e.oldValue == null ? 'null' : String(e.oldValue);
    const newS = e.newValue == null ? 'null' : String(e.newValue);
    const icon = e.status === 'verified' ? '✅' : e.status === 'sent' ? '⚠️' : e.status === 'failed' ? '❌' : '🔙';
    const color = e.status === 'verified' ? 'var(--success)' : e.status === 'sent' ? 'var(--warning)' : e.status === 'failed' ? 'var(--danger)' : 'var(--text-secondary)';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid color-mix(in srgb, var(--text) 4%, transparent);font-size:12px;">
      <span style="color:var(--text-tertiary);flex-shrink:0;">${ts}</span>
      <span style="color:var(--feat-autoupgrade);flex-shrink:0;">${e.fieldPath}</span>
      <span style="color:var(--text-secondary);flex:1;">${oldS} → <span style="color:var(--text);">${newS}</span></span>
      <span style="color:${color};">${icon}</span>
    </div>`;
  }).join('');
}

// Update the log container + count in the DOM without re-rendering the whole body
function updateLogInPlace() {
  const logContainer = document.getElementById('psycle-explorer-log-container');
  const logCount = document.getElementById('psycle-explorer-log-count');
  if (logContainer) logContainer.innerHTML = renderLogEntriesHtml();
  if (logCount) logCount.textContent = `(${changeLog.length})`;
}

async function saveProfileChanges(body, originalProfile) {
  const saveBtn = document.getElementById('psycle-profile-save-btn');
  if (!saveBtn) return;

  // Collect changed fields
  const changes = [];
  body.querySelectorAll('.psycle-profile-edit-input').forEach(input => {
    const path = input.getAttribute('data-path');
    const origVal = getByPath(originalProfile, path);
    let newVal;
    if (input.type === 'checkbox') {
      newVal = input.checked;
    } else {
      const raw = input.value;
      if (raw === '' && input.placeholder === 'null') newVal = null;
      else {
        // Try to preserve number type
        const num = Number(raw);
        if (!isNaN(num) && raw.trim() !== '' && typeof origVal === 'number') newVal = num;
        else newVal = raw;
      }
    }
    if (String(newVal) !== String(origVal)) {
      changes.push({ path, oldValue: origVal, newValue: newVal });
    }
  });

  if (changes.length === 0) {
    showToast('No changes to save', 'info');
    return;
  }

  // Build the updated profile payload
  const payload = JSON.parse(JSON.stringify(loadedProfile));
  changes.forEach(c => setByPath(payload, c.path, c.newValue));

  // Disable save button, show spinner
  saveBtn.disabled = true;
  saveBtn.textContent = '⏳ Saving...';

  // Add entries to the module-level change log (persists across saves)
  const newEntries = changes.map(c => ({
    timestamp: new Date(),
    fieldPath: c.path,
    oldValue: c.oldValue,
    newValue: c.newValue,
    status: 'sent'
  }));
  changeLog.push(...newEntries);
  updateLogInPlace();

  try {
    // Send the update
    await api.proxyPost('/account/update', payload);

    // Re-fetch to verify
    try {
      const refetched = await api.proxyGet('/profile');
      const refetchedProfile = refetched.data || refetched;

      // Verify each new entry and update input values in-place
      newEntries.forEach(entry => {
        const verifiedVal = getByPath(refetchedProfile, entry.fieldPath);
        if (String(verifiedVal) === String(entry.newValue)) {
          entry.status = 'verified';
          setByPath(loadedProfile, entry.fieldPath, entry.newValue);
          setByPath(originalProfile, entry.fieldPath, entry.newValue); // update baseline for future change detection
        } else {
          entry.status = 'reverted';
          setByPath(loadedProfile, entry.fieldPath, verifiedVal);
          setByPath(originalProfile, entry.fieldPath, verifiedVal); // update baseline to actual persisted value
        }

        // Update the input element in-place to reflect verified/reverted value
        const input = body.querySelector(`.psycle-profile-edit-input[data-path="${entry.fieldPath}"]`);
        if (input) {
          if (input.type === 'checkbox') {
            input.checked = verifiedVal === true;
          } else {
            const pv = verifiedVal !== null && verifiedVal !== undefined ? String(verifiedVal) : '';
            input.value = pv;
            input.placeholder = verifiedVal === null ? 'null' : '';
          }
        }
      });

      updateLogInPlace();
      showToast('Profile saved and verified', 'success');

    } catch (verifyErr) {
      // Verification fetch failed — changes were sent but not verified
      newEntries.forEach(entry => { entry.status = 'sent'; });
      updateLogInPlace();
      showToast('Saved but verification failed: ' + verifyErr.message, 'warning');
    }

  } catch (err) {
    newEntries.forEach(entry => { entry.status = 'failed'; });
    updateLogInPlace();
    showToast(`Save failed: ${err.message}`, 'error');
  }

  saveBtn.disabled = false;
  saveBtn.textContent = '💾 Save Changes';
  saveBtn.style.display = 'none';
}

// ─── Active Studio IDs — cached 24h, derived from timetable events ──────────

const ACTIVE_STUDIO_IDS_KEY = 'psycleActiveStudioIds';
const ACTIVE_STUDIO_IDS_TIME_KEY = 'psycleActiveStudioIdsTime';
const ACTIVE_STUDIO_IDS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getActiveStudioIds() {
  // Check localStorage cache first (24h TTL)
  const cachedTime = parseInt(localStorage.getItem(ACTIVE_STUDIO_IDS_TIME_KEY) || '0', 10);
  const cacheAge = Date.now() - cachedTime;
  if (cacheAge < ACTIVE_STUDIO_IDS_TTL_MS) {
    const cached = localStorage.getItem(ACTIVE_STUDIO_IDS_KEY);
    if (cached) {
      try { return new Set(JSON.parse(cached)); } catch (_) { /* fall through */ }
    }
  }

  // Cache stale or missing — recompute from timetable events in IndexedDB
  try {
    const events = await cacheGet('psycleCacheEvents');
    if (events && Array.isArray(events) && events.length > 0) {
      const ids = new Set();
      events.forEach(ev => {
        const id = ev.studio_id || ev.studio?.id;
        if (id) ids.add(id);
      });
      // Persist to localStorage
      localStorage.setItem(ACTIVE_STUDIO_IDS_KEY, JSON.stringify([...ids]));
      localStorage.setItem(ACTIVE_STUDIO_IDS_TIME_KEY, String(Date.now()));
      return ids;
    }
  } catch (e) {
    console.warn('[SpotMaps] Failed to read timetable events for active studio filter:', e);
  }

  // No timetable data available at all
  return null;
}

export async function openManageSpotMapsModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:color-mix(in srgb, var(--bg) 60%, transparent);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);border-radius:16px;width:100%;max-width:500px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;';
  header.innerHTML = `<h3 style="margin:0;font-size:16px;font-weight:700;color:var(--text);">Preferred Spot Maps</h3><button style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:0;line-height:1;" id="manage-modal-close">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';
  body.innerHTML = '<div style="text-align:center;padding:24px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:var(--text-secondary);margin-top:10px;font-size:13px;">Loading studios…</div></div>';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  header.querySelector('#manage-modal-close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  try {
    const [prefs, cachedMeta, cachedEvents] = await Promise.all([
      api.getStudioPreferences(),
      cacheGet('psycleCacheMeta'),
      cacheGet('psycleCacheEvents')
    ]);

    // Studios from the timetable metadata cache (built from event relations) include full
    // layout.slots data — the /studios list endpoint omits slots for some studios (e.g. Reformer).
    const studios = cachedMeta?.studios || [];

    // Build a set of studio IDs that actually have upcoming events, to exclude defunct studios
    // that appear in API relations but no longer have any classes scheduled.
    const activeStudioIds = new Set();
    if (cachedEvents?.length > 0) {
      cachedEvents.forEach(ev => {
        const id = ev.studio_id || ev.studio?.id;
        if (id) activeStudioIds.add(id);
      });
    }

    let locations = cachedMeta?.locations || cache.locations || [];
    if (!locations.length) {
      try {
        const locRes = await api.proxyGet('/locations', { ttlMs: 3600000 });
        locations = locRes.data || locRes || [];
        cache.locations = locations;
      } catch (e) {
        locations = [];
      }
    }

    renderManageSpotMapsModal(prefs, studios, locations, body, close, activeStudioIds);
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error" style="padding:16px;">Unable to load studios. Connect to the internet to sync. (${err.message})</div>`;
  }
}

function renderManageSpotMapsModal(prefs, studios, locations, container, onClose, activeStudioIds) {
  const locMap = {};
  locations.forEach(loc => { locMap[loc.id] = loc.name; });

  const hasActiveFilter = activeStudioIds && activeStudioIds.size > 0;

  const grouped = {};
  studios.forEach(studio => {
    if (!studio.layout?.slots || studio.layout.slots.length === 0) return; // only studios with seat maps
    if (hasActiveFilter && !activeStudioIds.has(studio.id)) return; // exclude defunct studios
    const locName = locMap[studio.location_id] || 'Unknown Location';
    if (!grouped[locName]) grouped[locName] = [];
    grouped[locName].push(studio);
  });

  const sortedLocs = Object.keys(grouped).sort();
  container.innerHTML = '';

  if (sortedLocs.length === 0) {
    const noData = studios.length === 0;
    container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-secondary);"><div style="font-size:32px;margin-bottom:12px;">🗺️</div><p style="margin:0;">${noData ? 'No Timetable Data' : 'No Studios With Seat Maps'}</p><p style="font-size:12px;margin:8px 0 0 0;">${noData ? 'Please open the Timetable tab first to load classes, then return here.' : 'No studios with seat layouts were found in the current timetable.'}</p></div>`;
    return;
  }

  sortedLocs.forEach((locName, locIdx) => {
    const locSection = document.createElement('div');
    locSection.style.cssText = 'margin-bottom:14px;';

    const locHeader = document.createElement('div');
    locHeader.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;padding:8px 0 6px 0;cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center;';
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
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:color-mix(in srgb, var(--text) 3%, transparent);border:1px solid color-mix(in srgb, var(--text) 6%, transparent);border-radius:8px;';

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;';

      const name = document.createElement('div');
      name.style.cssText = 'font-size:13px;font-weight:500;color:var(--text);';
      name.textContent = studio.name;
      info.appendChild(name);

      if (hasPrefs) {
        const detail = document.createElement('div');
        detail.style.cssText = 'font-size:12px;color:var(--text-tertiary);margin-top:2px;';
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
      editBtn.style.cssText = 'font-size:12px;padding:4px 10px;';
      editBtn.textContent = hasPrefs ? 'Edit Spots' : 'Choose Spots';
      editBtn.addEventListener('click', () => openStudioFloorPlanEditor(studio.id, studio.name, () => openManageSpotMapsModal()));
      btns.appendChild(editBtn);

      if (hasPrefs) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'psycle-btn-mini';
        removeBtn.style.cssText = 'font-size:12px;padding:4px 10px;background:color-mix(in srgb, var(--danger) 10%, transparent);border-color:color-mix(in srgb, var(--danger) 25%, transparent);color:var(--danger);';
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

    // Collapsible toggle — all sections start closed
    studioList.style.display = 'none';
    chevron.style.transform = 'rotate(-90deg)';

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
  overlay.style.cssText = 'position:fixed;inset:0;background:color-mix(in srgb, var(--bg) 60%, transparent);z-index:2000;display:flex;align-items:center;justify-content:center;padding:16px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);border-radius:16px;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;';
  header.innerHTML = `<div><div style="font-size:15px;font-weight:700;color:var(--text);">Spot Map</div><div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">${studioName}</div></div><button style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:0;line-height:1;" id="spot-editor-close">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';
  body.innerHTML = '<div style="text-align:center;padding:24px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:var(--text-secondary);margin-top:10px;font-size:13px;">Loading floor plan…</div></div>';

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  header.querySelector('#spot-editor-close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  try {
    const [studioRes, allPrefs] = await Promise.all([
      api.proxyGet(`/studios/${studioId}`, { ttlMs: 3600000 }),
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
        <div style="padding:20px;text-align:center;color:var(--text-secondary);">
          <div style="font-size:32px;margin-bottom:12px;">🗺️</div>
          <p style="margin:0 0 8px;color:var(--text);font-weight:500;">No floor map available</p>
          <p style="font-size:12px;margin:0 0 20px;">Preferences will apply to any available spot when booking at this studio.</p>
          <button class="psycle-btn" id="spot-save-any" style="background:var(--feat-autoupgrade);color:var(--on-accent);">Save (Any Spot Preference)</button>
        </div>
      `;
      body.querySelector('#spot-save-any').onclick = () => onSave([], existing.preferredRows || []);
      return;
    }

    renderStudioFloorPlan(body, layoutSlots, existing.preferredSlots || [], existing.preferredRows || [], onSave, {
      layoutObjects: studio?.layout?.objects || [],
      bannerHtml: `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 18%, transparent);border-radius:8px;padding:8px 10px;margin-bottom:12px;line-height:1.5;">This is the one shared preferred spot map for <strong>${studioName}</strong>. Quick-Book, Auto-Book, and Auto-Upgrade at this studio all use it — changes apply everywhere.</div>`
    });
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error" style="padding:16px;">Unable to load floor plan. Connect to the internet to sync. (${err.message})</div>`;
  }
}

export async function initSettings() {
  loadSettingsInputs();
  setupSettingsListeners();
  setupThemeToggle();
  setupNotificationPrefs();
  updateTestNotifCardVisibility();
  // Konami listener is attached on first profile explorer modal open via setupExplorerKonamiListener()
  updatePushStatusUI();
  setupCalendarCard();
  // Spot Maps section is ready; button opens the modal
}

// ─── Calendar feed card ───────────────────────────────────────────────────────
let calendarLinks = null;

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

// Open an external URL from inside the installed PWA. window.open('_blank') leaves a
// blank standalone window on iOS; a transient anchor click hands off to Safari cleanly.
function openExternal(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderCalendarCardState(status) {
  const desc = document.getElementById('psycle-calendar-status-desc');
  const toggleBtn = document.getElementById('psycle-calendar-toggle-btn');
  const options = document.getElementById('psycle-calendar-options');
  const tentative = document.getElementById('psycle-calendar-tentative');
  const alarm = document.getElementById('psycle-calendar-alarm');
  const apple = document.getElementById('psycle-calendar-apple-btn');
  const google = document.getElementById('psycle-calendar-google-btn');
  if (!desc || !toggleBtn || !options) return;

  calendarLinks = status && status.links ? status.links : null;

  if (status && status.enabled) {
    toggleBtn.style.display = 'none';
    options.style.display = 'block';
    if (tentative) tentative.checked = !!status.includeTentative;
    if (alarm) alarm.value = status.alarm || 'none';
    const when = status.generatedAt
      ? new Date(status.generatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
      : 'just now';
    const n = status.classCount || 0;
    desc.innerHTML = `Feed active · ${n} class${n === 1 ? '' : 'es'} · updated ${when} <button id="psycle-calendar-refresh-btn" title="Refresh now" style="background:none;border:none;cursor:pointer;color:var(--text-secondary);font-size:14px;padding:0 2px;vertical-align:middle;line-height:1;" aria-label="Refresh calendar feed">↻</button>`;
    // Lead with the platform-native option.
    if (apple && google && isIOSDevice()) { apple.style.order = '0'; google.style.order = '1'; }
  } else {
    toggleBtn.style.display = '';
    toggleBtn.textContent = 'Turn on';
    options.style.display = 'none';
    desc.textContent = 'Turn on to get a personal calendar link.';
  }
}

async function refreshCalendarCard() {
  try {
    const status = await api.getCalendarStatus();
    renderCalendarCardState(status);
  } catch (_) { /* card stays in default state */ }
}

function setupCalendarCard() {
  const card = document.getElementById('psycle-calendar-card');
  if (!card || card.dataset.listener) { refreshCalendarCard(); return; }
  card.dataset.listener = 'true';

  const toggleBtn = document.getElementById('psycle-calendar-toggle-btn');
  const disableBtn = document.getElementById('psycle-calendar-disable-btn');
  const tentative = document.getElementById('psycle-calendar-tentative');
  const alarm = document.getElementById('psycle-calendar-alarm');
  const apple = document.getElementById('psycle-calendar-apple-btn');
  const google = document.getElementById('psycle-calendar-google-btn');
  const copy = document.getElementById('psycle-calendar-copy-btn');

  toggleBtn?.addEventListener('click', async () => {
    toggleBtn.disabled = true;
    try {
      const res = await api.enableCalendar({
        includeTentative: tentative ? tentative.checked : false,
        alarm: alarm ? alarm.value : 'none',
      });
      calendarLinks = res.links || null;
      await refreshCalendarCard();
      showToast('Calendar feed turned on. Add it to your calendar below.', 'success');
    } catch (err) {
      showToast(`Couldn't turn on calendar: ${err.message}`, 'error');
    } finally {
      toggleBtn.disabled = false;
    }
  });

  disableBtn?.addEventListener('click', async () => {
    disableBtn.disabled = true;
    try {
      await api.disableCalendar();
      calendarLinks = null;
      await refreshCalendarCard();
      showToast('Calendar feed turned off. Remove the “Psycle Classes” calendar from your calendar app to clear it.', 'info');
    } catch (err) {
      showToast(`Couldn't turn off calendar: ${err.message}`, 'error');
    } finally {
      disableBtn.disabled = false;
    }
  });

  const saveCalendarPrefs = async () => {
    try {
      userSettings.calendar = {
        ...(userSettings.calendar || {}),
        enabled: true,
        includeTentative: tentative ? tentative.checked : false,
        alarm: alarm ? alarm.value : 'none',
      };
      await api.updateSettings(userSettings);
      refreshCalendarCard();
    } catch (err) {
      showToast(`Couldn't save calendar settings: ${err.message}`, 'error');
    }
  };
  tentative?.addEventListener('change', saveCalendarPrefs);
  alarm?.addEventListener('change', saveCalendarPrefs);

  apple?.addEventListener('click', () => {
    if (calendarLinks?.webcal) window.location.href = calendarLinks.webcal;
  });
  google?.addEventListener('click', () => {
    if (calendarLinks?.google) openExternal(calendarLinks.google);
  });
  copy?.addEventListener('click', async () => {
    if (!calendarLinks?.https) return;
    try {
      await navigator.clipboard.writeText(calendarLinks.https);
      showToast('Feed link copied to clipboard.', 'success');
    } catch (_) {
      showToast(calendarLinks.https, 'info');
    }
  });

  refreshCalendarCard();
}

// ─── Theme toggle (Auto / Light / Dark) ──────────────────────────────────────
function setupThemeToggle() {
  const group = document.getElementById('psycle-theme-segmented');
  if (!group || group.dataset.listener) return;
  group.dataset.listener = 'true';

  const sync = () => {
    const active = getTheme();
    group.querySelectorAll('.psycle-segmented-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.themeMode === active);
    });
  };

  group.querySelectorAll('.psycle-segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTheme(btn.dataset.themeMode);
      sync();
    });
  });
  sync();
}

// ─── Notification preferences ────────────────────────────────────────────────

const NOTIF_DEFAULTS = {
  booking: { enabled: true, scope: 'all' },
  upgrade: { enabled: true },
  creditWarning: { enabled: true },
  cancellationReminder: { enabled: true, timing: '24h' },
  bookingWindow: { enabled: true },
};

function getNotifPrefs() {
  const n = userSettings.notifications || {};
  const merged = {};
  for (const key of Object.keys(NOTIF_DEFAULTS)) {
    merged[key] = { ...NOTIF_DEFAULTS[key], ...(n[key] || {}) };
  }
  return merged;
}

const NOTIF_ROWS = [
  { key: 'booking', title: 'Spot Booked', desc: 'When a class is successfully booked.',
    dropdown: { prop: 'scope', options: [['all', 'All Bookings'], ['autobook', 'Auto-Book only']] } },
  { key: 'upgrade', title: 'Spot Upgraded', desc: 'When auto-upgrade moves you to a better spot.' },
  { key: 'creditWarning', title: 'Credit Warning', desc: "When you set something up but don't have enough credits." },
  { key: 'cancellationReminder', title: 'Cancellation Reminder', desc: 'Reminder to cancel before the free-cancel window closes.',
    dropdown: { prop: 'timing', options: [['24h', '1 day before (24h)'], ['14h', 'Before penalty (14h)']] } },
  { key: 'bookingWindow', title: 'Booking Window Reminder', desc: 'Heads-up 1 hour before the Monday release.' },
];

function renderNotifPrefs() {
  const body = document.getElementById('psycle-notif-prefs-body');
  if (!body) return;
  const prefs = getNotifPrefs();

  body.innerHTML = `
    <p style="font-size:12px;color:var(--text-secondary);margin:0 0 16px;line-height:1.5;">Choose which push notifications you receive. Changes apply to all your devices.</p>
    ${NOTIF_ROWS.map(row => {
      const p = prefs[row.key];
      const dd = row.dropdown ? `
        <select class="psycle-select notif-dropdown" data-key="${row.key}" data-prop="${row.dropdown.prop}" style="margin-top:8px;width:100%;font-size:12px;">
          ${row.dropdown.options.map(([val, label]) => `<option value="${val}" ${p[row.dropdown.prop] === val ? 'selected' : ''}>${label}</option>`).join('')}
        </select>` : '';
      return `
        <div style="border:1px solid color-mix(in srgb, var(--text) 8%, transparent);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:color-mix(in srgb, var(--text) 2%, transparent);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;color:var(--text);">${row.title}</div>
              <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;line-height:1.4;">${row.desc}</div>
            </div>
            <label class="psycle-switch" style="flex-shrink:0;">
              <input type="checkbox" class="notif-toggle" data-key="${row.key}" ${p.enabled ? 'checked' : ''}>
              <span class="psycle-slider"></span>
            </label>
          </div>
          ${dd ? `<div class="notif-dropdown-wrap" data-key="${row.key}" style="${p.enabled ? '' : 'opacity:0.4;pointer-events:none;'}">${dd}</div>` : ''}
        </div>`;
    }).join('')}
  `;

  body.querySelectorAll('.notif-toggle').forEach(el => {
    el.addEventListener('change', () => {
      const wrap = body.querySelector(`.notif-dropdown-wrap[data-key="${el.dataset.key}"]`);
      if (wrap) { wrap.style.opacity = el.checked ? '' : '0.4'; wrap.style.pointerEvents = el.checked ? '' : 'none'; }
      saveNotifPrefs();
    });
  });
  body.querySelectorAll('.notif-dropdown').forEach(el => {
    el.addEventListener('change', saveNotifPrefs);
  });
}

async function saveNotifPrefs() {
  const body = document.getElementById('psycle-notif-prefs-body');
  if (!body) return;
  const prefs = getNotifPrefs();
  body.querySelectorAll('.notif-toggle').forEach(el => {
    prefs[el.dataset.key].enabled = el.checked;
  });
  body.querySelectorAll('.notif-dropdown').forEach(el => {
    prefs[el.dataset.key][el.dataset.prop] = el.value;
  });

  userSettings.notifications = prefs;
  try {
    await api.updateSettings({ ...userSettings, notifications: prefs });
  } catch (err) {
    showToast(`Failed to save notification settings: ${err.message}`, 'error');
  }
}

function setupNotificationPrefs() {
  const openBtn = document.getElementById('psycle-notif-prefs-btn');
  const modal = document.getElementById('psycle-notif-prefs-modal');
  const closeBtn = document.getElementById('psycle-notif-prefs-close');
  console.log('[setupNotificationPrefs] openBtn:', openBtn, 'modal:', modal, 'closeBtn:', closeBtn);
  if (openBtn && !openBtn.dataset.listener) {
    openBtn.dataset.listener = 'true';
    openBtn.addEventListener('click', () => {
      console.log('[notif-btn-click] renderNotifPrefs and showing modal');
      renderNotifPrefs();
      modal.classList.add('show');
    });
  }
  if (closeBtn && !closeBtn.dataset.listener) {
    closeBtn.dataset.listener = 'true';
    const close = () => { modal.classList.remove('show'); };
    closeBtn.addEventListener('click', close);
    modal.querySelector('.psycle-modal-overlay').addEventListener('click', close);
  }

  // Debug test-notification buttons
  document.querySelectorAll('.test-notif-btn').forEach(btn => {
    if (btn.dataset.listener) return;
    btn.dataset.listener = 'true';
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const orig = btn.textContent;
      btn.disabled = true;
      try {
        await api.triggerPushTestType(type);
        showToast('Test notification sent to all devices.', 'success');
      } catch (err) {
        showToast(`Test failed: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    });
  });
}

function updateTestNotifCardVisibility() {
  const card = document.getElementById('psycle-test-notif-card');
  if (card) card.style.display = userSettings.debugMode ? 'block' : 'none';
}

// Render the detected booking-window indicator and show/hide the debug manual override.
function updateBookingWindowUI() {
  const indicator = document.getElementById('psycle-booking-window-indicator');
  const manualRow = document.getElementById('psycle-manual-window-row');

  if (indicator) {
    const offsetDays = getBookingOffset(userSettings);
    const cutoffISO = cache.bookingWindow?.cutoffISO || null;
    indicator.textContent = describeBookingWindow(offsetDays, cutoffISO);
    const isManual = !!(userSettings.debugMode && userSettings.manualBookingWindowWeeks);
    indicator.classList.toggle('warning', isManual);
    indicator.classList.toggle('info', !isManual);
    indicator.title = isManual ? 'Manual override active (debug)' : 'Auto-detected from your membership';
  }

  // Manual override is only visible (and only effective) in debug mode.
  if (manualRow) manualRow.style.display = userSettings.debugMode ? 'flex' : 'none';
}

function loadSettingsInputs() {
  const manualWindow = document.getElementById('psycle-setting-manual-window');
  const upgradeEnabled = document.getElementById('psycle-setting-autoupgrade-enabled');
  const upgradeDefault = document.getElementById('psycle-setting-autoupgrade-default');
  const upgradeInterval = document.getElementById('psycle-setting-autoupgrade-interval');
  const debugMode = document.getElementById('psycle-setting-debug-mode');
  const prefetchWeeks = document.getElementById('psycle-setting-prefetch-weeks');

  if (manualWindow) manualWindow.value = userSettings.manualBookingWindowWeeks ? String(userSettings.manualBookingWindowWeeks) : '';
  if (upgradeEnabled) upgradeEnabled.checked = userSettings.autoUpgradeEnabled !== false;
  if (upgradeDefault) upgradeDefault.checked = !!userSettings.autoUpgradeByDefault;
  if (upgradeInterval) upgradeInterval.value = userSettings.autoUpgradeInterval || '15min';
  if (debugMode) debugMode.checked = !!userSettings.debugMode;
  if (prefetchWeeks) prefetchWeeks.value = String(userSettings.prefetchWeeks || 4);

  updateBookingWindowUI();
}

function setupSettingsListeners() {
  const manualWindow = document.getElementById('psycle-setting-manual-window');
  const upgradeEnabled = document.getElementById('psycle-setting-autoupgrade-enabled');
  const upgradeDefault = document.getElementById('psycle-setting-autoupgrade-default');
  const upgradeInterval = document.getElementById('psycle-setting-autoupgrade-interval');
  const debugMode = document.getElementById('psycle-setting-debug-mode');
  const prefetchWeeks = document.getElementById('psycle-setting-prefetch-weeks');

  const saveSettings = async () => {
    // Spread existing settings first so unmanaged keys (notifications, cartInstanceId,
    // detectedBookingOffset) survive.
    const newSettings = {
      ...userSettings,
      manualBookingWindowWeeks: manualWindow && manualWindow.value ? parseInt(manualWindow.value) : null,
      autoUpgradeEnabled: upgradeEnabled ? upgradeEnabled.checked : true,
      autoUpgradeByDefault: upgradeDefault ? upgradeDefault.checked : false,
      autoUpgradeInterval: upgradeInterval ? upgradeInterval.value : '15min',
      debugMode: debugMode ? debugMode.checked : false,
      prefetchWeeks: prefetchWeeks ? parseInt(prefetchWeeks.value) : 4
    };

    try {
      await api.updateSettings(newSettings);
      Object.assign(userSettings, newSettings);
      updateTestNotifCardVisibility();
      updateBookingWindowUI();
      showToast('Settings saved successfully.', 'success');
    } catch (err) {
      showToast(`Error saving settings: ${err.message}`, 'error');
    }
  };

  if (manualWindow && !manualWindow.dataset.listener) {
    manualWindow.dataset.listener = 'true';
    manualWindow.addEventListener('change', saveSettings);
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
    profileBtn.addEventListener('click', openProfileExplorerModal);
  }

  // Profile explorer modal close (handled inside openProfileExplorerModal via setupExplorerModalClose,
  // but keep a fallback here for safety)
  const explorerModal = document.getElementById('psycle-profile-explorer-modal');
  const explorerClose = document.getElementById('psycle-profile-explorer-close');
  if (explorerModal && explorerClose && !explorerClose.dataset.listener) {
    explorerClose.dataset.listener = 'true';
    const closeExplorer = () => {
      explorerModal.classList.remove('show');
      setTimeout(() => { explorerModal.style.display = 'none'; }, 300);
      explorerModalOpen = false;
      editMode = false;
      konamiProgress = 0;
    };
    explorerClose.addEventListener('click', closeExplorer);
    const overlay = explorerModal.querySelector('.psycle-modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', closeExplorer);
    }
  }

  // Spot maps button
  const spotMapsBtn = document.getElementById('psycle-spotmaps-load-btn');
  if (spotMapsBtn && !spotMapsBtn.dataset.listener) {
    spotMapsBtn.dataset.listener = 'true';
    spotMapsBtn.addEventListener('click', openManageSpotMapsModal);
  }

  // Replay onboarding button
  const replayBtn = document.getElementById('psycle-replay-onboarding-btn');
  if (replayBtn && !replayBtn.dataset.listener) {
    replayBtn.dataset.listener = 'true';
    replayBtn.addEventListener('click', async () => {
      const { startOnboarding } = await import('./onboarding');
      localStorage.removeItem('psycleOnboardingComplete');
      localStorage.removeItem('psycleOnboardingStep');
      startOnboarding();
    });
  }

  // Logout button
  const logoutBtn = document.getElementById('psycle-logout-btn');
  if (logoutBtn && !logoutBtn.dataset.listener) {
    logoutBtn.dataset.listener = 'true';
    logoutBtn.addEventListener('click', () => {
      showToast('Logging out...', 'info');
      clearApiCache().catch(() => {}).finally(() => {
        localStorage.removeItem('psycleLocalToken');
        window.location.reload();
      });
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
        deleteDataBtn.style.background = 'var(--danger)';
        deleteDataBtn.style.color = 'var(--on-accent)';
        deleteDataBtn.style.borderColor = 'var(--danger)';
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
