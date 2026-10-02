import { api, apiFetch } from '../api';
import { showToast, togglePushSubscription, updatePushStatusUI, userSettings, cache, getTheme, setTheme, debugConsole, loadGymContext, refreshUserData, updateDebugTerminalVisibility, getIsOffline } from '../main';
import { getBookingOffset, describeBookingWindow } from '../lib';
import { renderStudioFloorPlan } from './spotmap';
import { isScrollBusy } from './scroll-state.js';
import { cacheGet, resetTimetableForGymChange } from './timetable';
import { clearApiCache, invalidateApiCache, accountScopedKey } from '../cache.js';
import { renderGymSettingsSection as renderGymSettingsSectionView } from './gym-settings-section.js';
import { renderCalendarSection } from './calendar-section.js';
import { getLinkedGyms, getGymShortName } from '../gym-context.js';
import { icon, gymSquareChip, gymBrand } from './cards.js';
import { createRenderGuard, reconcileKeyed, lastAuthLabel, connectionHealth } from './gym-connections.js';
import { COPY, formatCopyText } from '../copy.js';
import { appConfig } from '../config.js';

let loadedProfile = null;
let activeSpotEditorOverlay = null;
let closeSpotMapManager = null;
let loadedProfileGymId = null;

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
    title: COPY.profileExplorer.sectionBasicInfo,
    emoji: '👤',
    paths: ['id', 'first_name', 'last_name', 'email', 'username', 'dob', 'telephone', 'referral_code', 'verified', 'created_at']
  },
  {
    title: COPY.profileExplorer.sectionAccountPayments,
    emoji: '💳',
    paths: ['stripe_id', 'card_brand', 'card_last_four', 'has_purchased', 'opt_ins', 'policies']
  },
  {
    title: COPY.profileExplorer.sectionMetafieldsPreferences,
    emoji: '⚙️',
    // Special: all metafields.* except metafields.public.bookmarks
    // Built dynamically in buildSections()
  },
  {
    title: COPY.profileExplorer.sectionBookingStats,
    emoji: '📊',
    paths: ['stats.total_bookings', 'stats.total_unique_bookings', 'stats.total_unique_bookings_attended', 'stats.credits_remaining', 'stats.total_attended_minutes', 'booking_cutoff', 'extended_cutoff']
  },
  {
    title: COPY.profileExplorer.sectionAvailableCredits,
    emoji: '🎟️',
    paths: ['available_credits']  // array — rendered as cards, read-only
  },
  {
    title: COPY.profileExplorer.sectionSubscriptions,
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
  if (!credits || credits.length === 0) return `<div style="color:var(--text-secondary);font-style:italic;text-align:center;font-size:12px;">${COPY.profileExplorer.noActiveCredits}</div>`;
  return credits.map(c => `
    <div style="background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent);border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="display:flex;flex-direction:column;gap:2px;">
        <strong style="color:var(--text);font-size:13px;">${c.credit_type?.name || COPY.profileExplorer.unknown}</strong>
        <span style="font-size:12px;color:var(--text-secondary);">${formatCopyText(COPY.profileExplorer.creditHandle, { handle: escapeHtml(c.credit_type?.handle || '—') })}</span>
      </div>
      <span style="background:var(--feat-autoupgrade);color:var(--on-accent);border-radius:12px;padding:4px 10px;font-size:12px;font-weight:700;box-shadow:0 2px 4px color-mix(in srgb, var(--feat-autoupgrade) 30%, transparent);border:1px solid color-mix(in srgb, var(--text) 10%, transparent);">${formatCopyText(COPY.profileExplorer.creditsLeft, { count: c.count })}</span>
    </div>
  `).join('');
}

function renderSubsHtml(subs, statuses) {
  const allSubs = [...(subs || []), ...(statuses || [])];
  if (allSubs.length === 0) return `<div style="color:var(--text-secondary);font-style:italic;text-align:center;font-size:12px;">${COPY.profileExplorer.noPlans}</div>`;
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
          <span style="font-size:12px;color:var(--text-secondary);">${formatCopyText(COPY.profileExplorer.planHandle, { handle: escapeHtml(s.handle || '—') })}</span>
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
    sections.push({ title: COPY.profileExplorer.sectionOther, emoji: '📦', fields: otherFields, isSpecial: false });
  }

  return sections;
}

// ─── Modal Functions ────────────────────────────────────────────────────────

async function openProfileExplorerModal(gymId = null, gymName = null) {
  const modal = document.getElementById('psycle-profile-explorer-modal');
  const body = document.getElementById('psycle-profile-explorer-body');
  if (!modal || !body) return;

  // Reset state
  editMode = false;
  konamiProgress = 0;
  explorerModalOpen = true;
  changeLog = [];
  loadedProfileGymId = gymId;
  const title = document.getElementById('psycle-profile-explorer-title');
  if (title) title.textContent = gymName ? formatCopyText(COPY.profileExplorer.gymTitle, { gymName }) : COPY.profileExplorer.title;

  // Show loading state — use .show class for opacity transition (matches booking/debug modal convention)
  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('show'), 10);
  body.innerHTML = `<div style="text-align:center;padding:40px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:var(--text-secondary);margin-top:10px;font-size:13px;">${COPY.profileExplorer.loading}</div></div>`;

  // Set up close handlers
  setupExplorerModalClose(modal);

  // Set up konami listener (scoped to modal open)
  setupExplorerKonamiListener();

  try {
    // The Profile Explorer exists to show the gym's OWN payload, so it reads
    // `.raw` deliberately — that is the thing it is a viewer for. It falls back
    // to the normalized fields when a provider exposes no raw blob.
    const res = await api.getNormalizedProfile(gymId);
    loadedProfile = res.raw || res;
    renderExplorerBody(body);
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error">${formatCopyText(COPY.settings.profileLoadFailed, { error: escapeHtml(err.message) })}</div>`;
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
      if (!confirm(COPY.settings.discardUnsaved)) return;
    }
  }
  editMode = !editMode;
  const body = document.getElementById('psycle-profile-explorer-body');
  renderExplorerBody(body);
  if (editMode) {
    showToast(COPY.settings.editEnabled, 'info');
  } else {
    showToast(COPY.settings.editDisabled, 'info');
  }
}

// ─── Render Functions ───────────────────────────────────────────────────────

function renderExplorerBody(body) {
  if (!loadedProfile) {
    body.innerHTML = `<div class="psycle-card-error">${COPY.profileExplorer.dataUnavailable}</div>`;
    return;
  }

  const sections = buildSections(loadedProfile);
  let html = '';

  // Edit mode banner
  if (editMode) {
    html += `<div style="background:color-mix(in srgb, var(--warning) 10%, transparent);border:1px solid color-mix(in srgb, var(--warning) 30%, transparent);border-radius:8px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
      <span style="color:var(--warning);font-weight:600;font-size:13px;">${COPY.profileExplorer.editBanner}</span>
      <span style="color:var(--text-secondary);font-size:12px;">${COPY.profileExplorer.exitEdit}</span>
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
          <span style="font-weight:700;font-size:13px;color:var(--text);display:flex;align-items:center;gap:6px;">${COPY.profileExplorer.changeLog} <span id="psycle-explorer-log-count" style="font-weight:400;font-size:12px;color:var(--text-secondary);">(${changeLog.length})</span></span>
          <span class="psycle-accordion-arrow" id="psycle-explorer-log-arrow" style="font-size:12px;color:var(--text-secondary);transition:transform 0.2s;">▲</span>
        </div>
        <div id="psycle-explorer-log-container" style="max-height:200px;overflow-y:auto;padding:8px;background:var(--surface-inset);border-top:1px solid color-mix(in srgb, var(--text) 5%, transparent);">
          ${logEntriesHtml}
        </div>
      </div>
    `;
    // Save Changes button
    html += `<button id="psycle-profile-save-btn" class="psycle-btn" style="width:100%;margin-top:12px;background:color-mix(in srgb, var(--feat-autoupgrade) 20%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 40%, transparent);color:var(--feat-autoupgrade);font-weight:700;display:none;">${COPY.profileExplorer.saveChanges}</button>`;
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
    titleSuffix = ` <span style="font-size:12px;color:var(--text-tertiary);font-weight:400;">${COPY.profileExplorer.readOnly}</span>`;
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
    return `<div style="padding:12px;text-align:center;color:var(--text-tertiary);font-style:italic;font-size:12px;">${COPY.profileExplorer.noChanges}</div>`;
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
    showToast(COPY.settings.noChanges, 'info');
    return;
  }

  // Build the updated profile payload
  const payload = JSON.parse(JSON.stringify(loadedProfile));
  changes.forEach(c => setByPath(payload, c.path, c.newValue));

  // Disable save button, show spinner
  saveBtn.disabled = true;
  saveBtn.textContent = `⏳ ${COPY.static.savingDots}`;

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
    await api.updateProfileFields(payload, loadedProfileGymId);

    // Re-fetch to verify
    try {
        const refetched = await api.getNormalizedProfile(loadedProfileGymId);
      const refetchedProfile = refetched.raw || refetched;

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
      showToast(COPY.settings.profileSaved, 'success');

    } catch (verifyErr) {
      // Verification fetch failed — changes were sent but not verified
      newEntries.forEach(entry => { entry.status = 'sent'; });
      updateLogInPlace();
      showToast(formatCopyText(COPY.settings.profileVerificationFailed, { error: verifyErr.message }), 'warning');
    }

  } catch (err) {
    newEntries.forEach(entry => { entry.status = 'failed'; });
    updateLogInPlace();
    showToast(formatCopyText(COPY.settings.profileSaveFailed, { error: err.message }), 'error');
  }

  saveBtn.disabled = false;
  saveBtn.textContent = `💾 ${COPY.bookings.saveChanges}`;
  saveBtn.style.display = 'none';
}

export async function openManageSpotMapsModal(options = {}) {
  closeSpotMapManager?.();
  activeSpotEditorOverlay?.remove();
  activeSpotEditorOverlay = null;
  const zIndex = options.zIndex ?? 2000;
  const onDone = options.onDone ?? null;

  const overlay = document.createElement('div');
  overlay.id = 'psycle-manage-spotmaps-overlay';
  overlay.style.cssText = `position:fixed;inset:0;background:color-mix(in srgb, var(--bg) 60%, transparent);z-index:${zIndex};display:flex;align-items:center;justify-content:center;padding:16px;`;

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);border-radius:16px;width:100%;max-width:500px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;';
  header.innerHTML = `<h3 style="margin:0;font-size:16px;font-weight:700;color:var(--text);">${COPY.spotMaps.preferredSpotMaps}</h3><button style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:0;line-height:1;" id="manage-modal-close" aria-label="${COPY.credits.closeModal}">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';
  body.innerHTML = `<div style="text-align:center;padding:24px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:var(--text-secondary);margin-top:10px;font-size:13px;">${COPY.spotMaps.loadingStudios}</div></div>`;

  modal.appendChild(header);
  modal.appendChild(body);

  const refreshOnGymChange = () => {
    activeSpotEditorOverlay?.remove();
    activeSpotEditorOverlay = null;
    close();
    openManageSpotMapsModal(options);
  };
  const close = () => {
    window.removeEventListener('psycle:gyms-changed', refreshOnGymChange);
    overlay.remove();
    if (closeSpotMapManager === close) closeSpotMapManager = null;
  };
  closeSpotMapManager = close;

  if (onDone) {
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:12px 16px;border-top:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;';
    const doneBtn = document.createElement('button');
    doneBtn.className = 'psycle-btn-primary';
    doneBtn.style.cssText = 'width:100%;';
    doneBtn.textContent = COPY.settings.done;
    doneBtn.addEventListener('click', () => { close(); onDone(); });
    footer.appendChild(doneBtn);
    modal.appendChild(footer);
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  header.querySelector('#manage-modal-close').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  window.addEventListener('psycle:gyms-changed', refreshOnGymChange);

  try {
    const [prefs, cachedMeta, cachedEvents, linkedRes] = await Promise.all([
      api.getStudioPreferences(options.gymId),
      // The gym-scoped cache keys already resolve to the gym in localStorage, so
      // a request for a DIFFERENT gym must not read them. With the ambient
      // active-gym state gone, an explicit gymId is by definition not "the
      // cached one" — fetch fresh rather than serve another gym's layout.
      options.gymId ? null : cacheGet(accountScopedKey('psycleUnifiedCacheMeta')),
      // C3-24: the unified timetable cache is what timetable.js writes; the old
      // `psycleCacheEvents` keys had no writer, so this always missed and the
      // active-studio filter never applied. It is merged across gyms, so it is
      // read for an explicit gym too and narrowed to that gym just below.
      cacheGet(accountScopedKey('psycleUnifiedCacheEvents')),
      api.getMyGyms().catch(() => ({ gyms: [] }))
    ]);
    const linkedGyms = linkedRes.gyms || linkedRes || [];
    options.gymNames = Object.fromEntries(linkedGyms.map((gym) => [
      gym.gym_id || gym.gymId || gym.id,
      gym.gym_name || gym.name || gym.gym_id || gym.id,
    ]));

    // Studios from the timetable metadata cache (built from event relations) include full
    // layout.slots data — the /studios list endpoint omits slots for some studios (e.g. Reformer).
    // Fall back to fetching directly from the API when there is no timetable cache yet
    // (e.g. first-run onboarding before the user has loaded the timetable).
    let studios = cachedMeta?.studios || [];
    let events = cachedEvents || [];
    // C3-4: `cache.locations` is an unscoped module-level fallback with no gym
    // tag of its own — it's whatever gym's Timetable tab happened to populate
    // it last. Same rule as `cachedMeta`/`cachedEvents` above: an explicit
    // `options.gymId` is by definition asking for a gym that fallback may not
    // hold, so only read it in the ambient (no gymId) case. Reading it
    // unconditionally left a non-context gym's editor with another gym's
    // locations already "loaded" (non-empty), which skipped the fresh fetch
    // below and then filtered every studio out as belonging to the wrong gym
    // — rendering "No Studios With Seat Maps" instead of that gym's rooms.
    let locations = cachedMeta?.locations || (options.gymId ? [] : cache.locations) || [];

    if (!studios.length || !events.length || !locations.length) {
      try {
        // One normalized call for both lists (WP-D9). MarianaTek has no studios
        // or locations endpoint at all and derives them from its class list, so
        // asking for them separately only ever worked for CodexFit gyms.
        if (!studios.length || !locations.length) {
          const meta = await api.getMetadata({ ttlMs: 3600000, gymId: options.gymId });
          if (!studios.length) studios = meta.studios || [];
          if (!locations.length) {
            locations = meta.locations || [];
            // Same rule in the other direction: don't let a gym-scoped fetch
            // overwrite the unscoped ambient fallback with one gym's locations —
            // a later ambient (no gymId) call would then read this gym's rooms
            // as if they were "the" locations regardless of which gym it meant.
            if (!options.gymId) cache.locations = locations;
          }
        }

        // Fetch events to build the activeStudioIds filter (WP-C1: via the
        // normalized endpoint — fetchTimetable() already fans out per-location
        // server-side, see providers/codexfit.js, so this no longer needs its
        // own per-location loop). Only `studio_id` is read below, so the
        // NormalizedEvent shape (no .raw needed) is enough on its own.
        if (!events.length && locations.length) {
          const now = new Date();
          const startDate = now.toISOString().split('T')[0];
          const endDate = new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

          try {
            const normalizedEvents = await api.getTimetable({ startDate, endDate, gymId: options.gymId });
            // C3-4 (found while verifying the fix above): normalized ids are
            // STRINGS (WP-D9) — MarianaTek's studio ids ("mock-room-BOXING")
            // are never numeric, so `Number(ne.studioId)` was NaN for every
            // JAB event. `activeStudioIds` below compares via `String(id)`
            // regardless, so the coercion here only ever needs to preserve the
            // id, not convert it — it happened to work for Psycle's numeric-
            // looking studio ids and silently emptied the filter (every studio
            // excluded) for JAB's.
            events = normalizedEvents.map(ne => ({ studio_id: ne.studioId, gymId: ne.gymId }));
          } catch (_) {
            // If events fetch fails, events stays empty (no filtering)
          }
        }
      } catch (_) {
        // If any fetch fails, proceed with what we have
      }
    }

    // A future Phase 3 drawer can render a non-active gym. The merged metadata
    // helpers deliberately return every linked gym, so narrow them back to the
    // section's explicit gym before rendering or editing provider ids.
    if (options.gymId) {
      studios = studios.filter(item => !item.gymId || item.gymId === options.gymId);
      locations = locations.filter(item => !item.gymId || item.gymId === options.gymId);
      events = events.filter(item => !item.gymId || item.gymId === options.gymId);
    }

    // Build a set of studio IDs that actually have upcoming events, to exclude defunct studios
    // that appear in API relations but no longer have any classes scheduled.
    // Normalized events expose `studioId` (a string); the pre-D9 raw shape used
    // `studio_id` (a number). Both are read, and ids are compared as strings —
    // a Number/string mismatch here empties the list silently rather than
    // erroring, which is exactly how the location filter broke in slice 1.
    const activeStudioIds = new Set();
    if (events?.length > 0) {
      events.forEach(ev => {
        const id = ev.studioId ?? ev.studio_id ?? ev.studio?.id;
        if (id != null) activeStudioIds.add(String(id));
      });
    }

    renderManageSpotMapsModal(prefs, studios, locations, body, close, activeStudioIds, options);
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error" style="padding:16px;">${formatCopyText(COPY.settings.studiosLoadFailed, { error: escapeHtml(err.message) })}</div>`;
  }
}

function renderManageSpotMapsModal(prefs, studios, locations, container, onClose, activeStudioIds, options = {}) {
  const locMap = {};
  locations.forEach(loc => {
    locMap[String(loc.id)] = loc.name;
    if (loc.gymId) locMap[`${loc.gymId}:${loc.id}`] = loc.name;
  });

  const hasActiveFilter = activeStudioIds && activeStudioIds.size > 0;

  const grouped = new Map();
  studios.forEach(studio => {
    // `hasLayout` on the normalized shape; the raw CodexFit list embedded the
    // layout itself. MarianaTek has no studios endpoint to embed one on, so it
    // derives this from whether the class is pick-a-spot.
    const hasMap = studio.hasLayout ?? (studio.layout?.slots?.length > 0);
    if (!hasMap) return; // only studios with seat maps
    if (hasActiveFilter && !activeStudioIds.has(String(studio.id))) return; // exclude defunct studios
    const locId = studio.locationId ?? studio.location_id;
    const locName = (studio.gymId && locMap[`${studio.gymId}:${locId}`]) || locMap[String(locId)] || COPY.static.unknownLocation;
    const gymId = studio.gymId || options.gymId || '';
    const gymName = options.gymNames?.[gymId] || studio.gymName || gymId || COPY.gymSettings.genericGym;
    const key = `${gymId}:${locName}`;
    if (!grouped.has(key)) grouped.set(key, { gymId, gymName, locName, studios: [] });
    grouped.get(key).studios.push(studio);
  });

  const sortedGroups = [...grouped.values()].sort((a, b) => a.gymName.localeCompare(b.gymName) || a.locName.localeCompare(b.locName));
  container.innerHTML = '';

  if (sortedGroups.length === 0) {
    const noData = studios.length === 0;
    container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-secondary);"><div style="font-size:32px;margin-bottom:12px;">🗺️</div><p style="margin:0;">${noData ? COPY.spotMaps.noTimetableData : COPY.spotMaps.noSeatMaps}</p><p style="font-size:12px;margin:8px 0 0 0;">${noData ? COPY.spotMaps.loadTimetableFirst : COPY.spotMaps.noSeatLayouts}</p></div>`;
    return;
  }

  let previousGym = null;
  sortedGroups.forEach(({ gymId, gymName, locName, studios: locationStudios }) => {
    const thisGym = `${gymId}:${gymName}`;
    if (thisGym !== previousGym) {
      const gymHeader = document.createElement('h4');
      gymHeader.textContent = gymName;
      gymHeader.style.cssText = 'margin:8px 0 2px;font-size:14px;font-weight:700;color:var(--text);';
      container.appendChild(gymHeader);
      previousGym = thisGym;
    }
    const locSection = document.createElement('div');
    locSection.style.cssText = 'margin:0 0 14px 12px;border-left:2px solid var(--border);padding-left:10px;';

    const locHeader = document.createElement('div');
    locHeader.style.cssText = 'font-size:12px;font-weight:700;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;padding:8px 0 6px 0;cursor:pointer;user-select:none;display:flex;justify-content:space-between;align-items:center;';
    const chevron = document.createElement('span');
    chevron.textContent = '▼';
    chevron.style.cssText = 'transition:transform 0.2s;';
    locHeader.innerHTML = `<span>${locName}</span>`;
    locHeader.appendChild(chevron);

    const studioList = document.createElement('div');
    studioList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    locationStudios.forEach(studio => {
      const studioPrefs = (studio.gymId && prefs[`${studio.gymId}:${studio.id}`]) || prefs[studio.id];
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
        if (studioPrefs.preferredSlots?.length > 0) parts.push(formatCopyText(COPY.spotMaps.preferredSpotsCount, { count: studioPrefs.preferredSlots.length, plural: studioPrefs.preferredSlots.length > 1 ? 's' : '' }));
        if (studioPrefs.preferredRows?.length > 0) parts.push(formatCopyText(COPY.spotMaps.preferredRowsCount, { count: studioPrefs.preferredRows.length, plural: studioPrefs.preferredRows.length > 1 ? 's' : '' }));
        detail.textContent = parts.join(' · ');
        info.appendChild(detail);
      }
      row.appendChild(info);

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;';

      const editBtn = document.createElement('button');
      editBtn.className = 'psycle-btn-mini';
      editBtn.style.cssText = 'font-size:12px;padding:4px 10px;';
      editBtn.textContent = hasPrefs ? COPY.spotMaps.editSpots : COPY.spotMaps.chooseSpots;
      editBtn.addEventListener('click', () => {
        // Transition between modals instead of stacking the editor over its
        // manager. Reopen the manager if the editor is dismissed without save.
        close();
        openStudioFloorPlanEditor(studio.id, studio.name, () => {
          openManageSpotMapsModal(options);
        }, { ...options, gymId: studio.gymId, onDismiss: () => openManageSpotMapsModal(options) });
      });
      btns.appendChild(editBtn);

      if (hasPrefs) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'psycle-btn-mini';
        removeBtn.style.cssText = 'font-size:12px;padding:4px 10px;background:color-mix(in srgb, var(--danger) 10%, transparent);border-color:color-mix(in srgb, var(--danger) 25%, transparent);color:var(--danger);';
        removeBtn.textContent = COPY.spotMaps.remove;
        removeBtn.addEventListener('click', async () => {
          if (!confirm(COPY.settings.confirmRemove)) return;
          removeBtn.disabled = true;
          removeBtn.textContent = COPY.spotMaps.removing;
          try {
            await api.updateStudioPreferences(studio.id, { preferredSlots: [], preferredRows: [] }, studio.gymId || options.gymId);
            showToast(COPY.settings.defaultsRemoved, 'success');
            onClose();
            openManageSpotMapsModal(options);
          } catch (err) {
            showToast(formatCopyText(COPY.settings.actionFailed, { error: err.message }), 'error');
            removeBtn.disabled = false;
            removeBtn.textContent = COPY.spotMaps.remove;
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


export async function openStudioFloorPlanEditor(studioId, studioName, onSaved, options = {}) {
  if (activeSpotEditorOverlay?.isConnected) return;
  // Build modal overlay
  const zIndex = (options.zIndex ?? 2000) + 1;
  const overlay = document.createElement('div');
  overlay.id = 'psycle-spotmap-editor-overlay';
  overlay.style.cssText = `position:fixed;inset:0;background:color-mix(in srgb, var(--bg) 60%, transparent);z-index:${zIndex};display:flex;align-items:center;justify-content:center;padding:16px;`;

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg);border:1px solid color-mix(in srgb, var(--text) 12%, transparent);border-radius:16px;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid color-mix(in srgb, var(--text) 8%, transparent);flex-shrink:0;';
  header.innerHTML = `<div><div style="font-size:15px;font-weight:700;color:var(--text);">${COPY.spotMaps.spotMap}</div><div style="font-size:12px;color:var(--text-tertiary);margin-top:2px;">${studioName}</div></div><button style="background:none;border:none;color:var(--text-secondary);font-size:22px;cursor:pointer;padding:0;line-height:1;" id="spot-editor-close" aria-label="${COPY.credits.closeModal}">×</button>`;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;overflow-y:auto;padding:16px;';
  body.innerHTML = `<div style="text-align:center;padding:24px;"><div class="psycle-spinner" style="margin:0 auto;"></div><div style="color:var(--text-secondary);margin-top:10px;font-size:13px;">${COPY.spotMaps.loadingFloorPlan}</div></div>`;

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const close = (dismissed = false) => {
    overlay.remove();
    if (activeSpotEditorOverlay === overlay) activeSpotEditorOverlay = null;
    if (dismissed) options.onDismiss?.();
  };
  activeSpotEditorOverlay = overlay;
  header.querySelector('#spot-editor-close').onclick = () => close(true);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(true); });

  try {
    // WP-C5 (Q12 follow-up): reads the new event-independent normalized
    // studio-layout endpoint instead of guessing at an unconfirmed singular
    // `GET /studios/{id}` (never actually documented — see
    // providers/codexfit.js fetchStudioLayout's doc comment). `layoutSlots`
    // is now NormalizedSlot[] directly (its `.id`/`.x`/`.y`/`.label` fields
    // already match what `renderStudioFloorPlan` expects) — this is the one
    // C5 call site where passing normalized shapes straight into the renderer
    // is safe, since (unlike the booking-modal sites) there's no session
    // cache mixing raw- and normalized-shaped slots to keep consistent.
    // `layoutObjects` (podium markers) now comes back normalized from the same
    // endpoint, so this standalone Manage Maps entry point draws the same floor
    // fixtures as the event-context booking modals do.
    const [{ slots: layoutSlots, objects: layoutObjects }, allPrefs] = await Promise.all([
      api.getStudioLayout(studioId, options.gymId),
      api.getStudioPreferences(options.gymId)
    ]);
    const existing = (options.gymId && allPrefs[`${options.gymId}:${studioId}`]) || allPrefs[studioId] || {};

    const onSave = async (slots, rows) => {
      try {
        await api.updateStudioPreferences(studioId, { preferredSlots: slots, preferredRows: rows }, options.gymId);
        showToast(formatCopyText(COPY.settings.spotMapSaved, { studio: studioName }), 'success');
        close();
        if (onSaved) onSaved();
      } catch (err) {
        showToast(formatCopyText(COPY.settings.spotMapSaveFailed, { error: err.message }), 'error');
      }
    };

    if (layoutSlots.length === 0) {
      body.innerHTML = `
        <div style="padding:20px;text-align:center;color:var(--text-secondary);">
          <div style="font-size:32px;margin-bottom:12px;">🗺️</div>
          <p style="margin:0 0 8px;color:var(--text);font-weight:500;">${COPY.spotMaps.noFloorMapAvailable}</p>
          <p style="font-size:12px;margin:0 0 20px;">${COPY.spotMaps.anySpotHelp}</p>
          <button class="psycle-btn" id="spot-save-any" style="background:var(--feat-autoupgrade);color:var(--on-accent);">${COPY.spotMaps.saveAnySpot}</button>
        </div>
      `;
      body.querySelector('#spot-save-any').onclick = () => onSave([], existing.preferredRows || []);
      return;
    }

    renderStudioFloorPlan(body, layoutSlots, existing.preferredSlots || [], existing.preferredRows || [], onSave, {
      layoutObjects,
      bannerHtml: `<div style="font-size:12px;color:var(--feat-autoupgrade);background:color-mix(in srgb, var(--feat-autoupgrade) 8%, transparent);border:1px solid color-mix(in srgb, var(--feat-autoupgrade) 18%, transparent);border-radius:8px;padding:8px 10px;margin-bottom:12px;line-height:1.5;">${formatCopyText(COPY.spotMaps.sharedSpotMapHtml, { studioName: escapeHtml(studioName) })}</div>`
    });
  } catch (err) {
    body.innerHTML = `<div class="psycle-card-error" style="padding:16px;">${formatCopyText(COPY.settings.floorPlanLoadFailed, { error: escapeHtml(err.message) })}</div>`;
  }
}

function setupSettingsNavigation() {
  const layout = document.getElementById('psycle-settings-layout-wrapper');
  if (!layout || layout.dataset.navListener) return;
  layout.dataset.navListener = 'true';

  // Queried LIVE on every activation, not cached here: per-gym entries and panes
  // are created asynchronously by renderGymsCard after this runs, and a snapshot
  // taken at setup time would never see them (clicking a gym would do nothing).
  const menuItems = () => layout.querySelectorAll('.psycle-settings-menu-item');
  const panes = () => layout.querySelectorAll('.psycle-settings-section-pane');
  const sectionTitle = document.getElementById('psycle-settings-section-title');
  const backBtn = document.getElementById('psycle-settings-back-btn');

  // Handle URL hash to select target section initially if hash contains a specific settings target
  const hash = location.hash.replace('#', '');
  const legacySectionMap = { booking: 'gyms', experience: 'account', advanced: 'account' };
  let initialSection = legacySectionMap[hash] || 'account';
  if (['account', 'gyms', 'about', 'calendar'].includes(hash)) initialSection = hash;

  const activateSection = (sectionId) => {
    menuItems().forEach(item => {
      const match = item.getAttribute('data-settings-section') === sectionId;
      item.classList.toggle('active', match);
      if (match && sectionTitle) {
        sectionTitle.textContent = item.querySelector('.menu-item-text')?.textContent || sectionId;
      }
    });

    panes().forEach(pane => {
      const paneId = `psycle-settings-pane-${sectionId}`;
      pane.classList.toggle('active', pane.id === paneId);
    });

    // On mobile, drill down
    layout.classList.add('show-pane');
  };

  // ONE delegated listener on the menu, so entries added later (the per-gym
  // ones) work without re-binding.
  layout.addEventListener('click', (event) => {
    const item = event.target.closest('.psycle-settings-menu-item');
    if (!item || !layout.contains(item)) return;
    activateSection(item.getAttribute('data-settings-section'));
  });
  // Exposed so renderGymsCard can select a gym's pane after creating it.
  layout.__activateSettingsSection = activateSection;

  // Attach mobile back button listener
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      layout.classList.remove('show-pane');
    });
  }

  // iOS-style left-edge swipe back (pane -> menu). Mobile only; reuses the back button's
  // handler for the actual navigation. Passive listeners: horizontal drags are claimed via
  // `touch-action: pan-y` on the content, so vertical scrolling is untouched. Requires
  // horizontal dominance and a distance/velocity threshold, and never starts while the
  // shared scroll clock (header transition) is busy.
  const content = layout.querySelector('.psycle-settings-content');
  if (content && backBtn) {
    const EDGE = 28, COMMIT = 90;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let sx = 0, sy = 0, st = 0, dx = 0, tracking = false, locked = false;
    const reset = (animate) => {
      content.style.transition = animate && !reduce.matches ? 'transform .22s ease' : 'none';
      content.style.transform = '';
    };
    content.addEventListener('touchstart', (e) => {
      tracking = false; locked = false;
      if (!window.matchMedia('(max-width: 768px)').matches || !layout.classList.contains('show-pane')) return;
      if (e.touches.length !== 1 || isScrollBusy()) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;               // must begin at the left edge
      sx = t.clientX; sy = t.clientY; st = performance.now(); dx = 0; tracking = true;
      content.style.transition = 'none';
    }, { passive: true });
    content.addEventListener('touchmove', (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const mx = t.clientX - sx, my = t.clientY - sy;
      if (!locked) {
        if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { tracking = false; reset(false); return; } // vertical scroll wins
        if (mx > 10 && mx > Math.abs(my) * 1.5) locked = true; else return;                                // horizontal dominance
      }
      dx = Math.max(0, mx);
      content.style.transform = `translateX(${dx}px)`;
    }, { passive: true });
    const end = () => {
      if (!tracking) return;
      tracking = false;
      const fast = dx / Math.max(1, performance.now() - st) > 0.5; // px/ms
      if (locked && (dx > COMMIT || (fast && dx > 30))) {
        if (reduce.matches) { reset(false); backBtn.click(); return; }
        content.style.transition = 'transform .18s ease';
        content.style.transform = `translateX(${window.innerWidth}px)`;
        setTimeout(() => { backBtn.click(); reset(false); }, 180);
      } else {
        reset(true);
      }
      locked = false;
    };
    content.addEventListener('touchend', end, { passive: true });
    content.addEventListener('touchcancel', end, { passive: true });
  }

  // Set initial state
  activateSection(initialSection);
  // Remove show-pane class initially so list displays first on mobile,
  // EXCEPT if the hash explicitly requested a section
  if (!['account', 'gyms', 'about', 'booking', 'experience', 'advanced'].includes(hash)) {
    layout.classList.remove('show-pane');
  }
}


// Local escape helper — gym names come from gyms.config.js (trusted), but the
// email/status/provider strings rendered below can originate from a provider
// response, and AGENTS.md flags unescaped innerHTML as a known weak spot. Cheap
// to be correct here rather than add to the pile.
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════════
//  YOUR GYMS — link/unlink and per-gym settings. NO SWITCHER.
//
//  A Sweat Assistant account holds N gym credentials (Decision D4), and the app
//  presents ONE unified view: the timetable, bookings, waitlists and queues show
//  every linked gym at once, and every row reads and writes through its own
//  `gymId`. There is therefore nothing for a user to switch BETWEEN, and a
//  "switch" control actively misleads — it implies the other gym's classes are
//  hidden until you flip something, which they are not.
//
//  The server still resolves an active gym (db.resolveActiveGymId) because
//  background cron has no request context and some single-gym paths need a
//  default. That is an implementation detail and must stay invisible: do not
//  surface it, do not add a switch button, and do not make any user-visible
//  behaviour depend on which gym happens to be persisted.
// ═══════════════════════════════════════════════════════════════════════

function gymModal() {
  const modal = document.getElementById('psycle-gym-modal');
  const body = document.getElementById('psycle-gym-modal-body');
  const title = document.getElementById('psycle-gym-modal-title');
  const close = () => {
    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
  };
  document.getElementById('psycle-gym-modal-close').onclick = close;
  modal.querySelector('.psycle-modal-overlay').onclick = close;
  const open = () => {
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);
  };
  return { modal, body, title, open, close };
}

// NOTE: `applyGymSwitch()` used to live here. It is gone with the switcher —
// see the section header above. Every cache key is gym-scoped (WP-G), so no
// cache clearing is needed on any gym-related action; do not re-add a "clear
// everything" helper to be safe, because that was the mechanism the old design
// leaned on and it was only ever correct while every caller remembered it.

// ── Your Gyms: render once, then update in place (U1-7) ─────────────────────
//
// The linked-gym list is already known at boot (`loadGymContext()` fetches it
// before Settings is bound), so the sidebar entries, per-gym panes and the
// connection table are painted SYNCHRONOUSLY from that, together with the rest of
// the menu. `GET /api/my-gyms` then only ENRICHES what is on screen (health,
// last-authenticated) by updating the same elements — rows are keyed by gym id
// and never rebuilt. See gym-connections.js for why the previous
// clear-then-append-in-a-loop render duplicated a gym when two renders overlapped.
const gymsRenderGuard = createRenderGuard();
let connByGym = new Map();

/** The connection table's static shell, built once per list host. */
function ensureConnTable(list) {
  if (list.querySelector('.psycle-gym-conn-table')) return list.querySelector('.psycle-gym-conn-table');
  list.innerHTML = `
    <div class="psycle-card-desc psycle-gym-conn-empty" style="padding:10px 0;" hidden>${COPY.settings.noGymsLinked}</div>
    <div class="psycle-gym-conn-table" role="table" aria-label="${COPY.settings.gymConnections}">
      <div class="psycle-gym-conn-head" role="row">
        <span role="columnheader">${COPY.settings.gym}</span>
        <span role="columnheader">${COPY.settings.connection}</span>
      <span role="columnheader">${COPY.settings.lastAuthenticated}</span>
        <span role="columnheader"><span class="u-visually-hidden">${COPY.settings.actions}</span></span>
      </div>
    </div>`;
  return list.querySelector('.psycle-gym-conn-table');
}

function connRowCreate(g) {
  const row = document.createElement('div');
  row.className = 'psycle-gym-conn-row';
  row.setAttribute('role', 'row');
  const id = escapeHtml(g.gym_id);
  row.innerHTML = `
    <span role="cell" class="psycle-gym-conn-name"><strong></strong><small></small></span>
    <span role="cell" class="psycle-gym-conn-health"><span class="psycle-gym-conn-dot" aria-hidden="true"></span><span class="psycle-gym-conn-label"></span></span>
    <span role="cell" class="psycle-gym-conn-when"></span>
    <span role="cell" class="psycle-gym-conn-actions">
      <button class="psycle-btn psycle-btn-mini" data-reauth-gym="${id}">${COPY.settings.reauthenticate}</button>
      <button class="psycle-btn psycle-btn-mini variant-danger" data-unlink-gym="${id}">${COPY.settings.unlink}</button>
    </span>`;
  return row;
}

function connRowUpdate(row, g) {
  const health = connectionHealth(g);
  row.querySelector('.psycle-gym-conn-name strong').textContent = g.gym_name || g.gym_id;
  row.querySelector('.psycle-gym-conn-name small').textContent = g.gym_email || g.provider || '';
  const h = row.querySelector('.psycle-gym-conn-health');
  h.className = `psycle-gym-conn-health ${health.cls}`;
  h.querySelector('.psycle-gym-conn-dot').textContent = health.icon;
  h.querySelector('.psycle-gym-conn-label').textContent = health.label;
  row.querySelector('.psycle-gym-conn-when').textContent = lastAuthLabel(g.last_authenticated_at);
}

function gymNavCreate() {
  const item = document.createElement('button');
  item.className = 'psycle-settings-menu-item psycle-settings-menu-sub';
  // U1-8: the gym's own 1:1 mark leads the entry (in place of a generic icon).
  item.innerHTML = '<span class="menu-item-lead"></span><span class="menu-item-text"></span>';
  return item;
}

function gymNavUpdate(item, g) {
  const lead = item.querySelector('.menu-item-lead');
  // Keyed on the RESOLVED brand too: a chip built before the gym catalogue loaded is the neutral grey
  // placeholder, and must be rebuilt once the real brand is known.
  const markKey = `${g.gym_id}:${gymBrand(g.gym_id).id}`;
  if (lead.getAttribute('data-mark') !== markKey) {
    lead.setAttribute('data-mark', markKey);
    lead.innerHTML = gymSquareChip(g.gym_id);
  }
  item.setAttribute('data-settings-section', `gym-${g.gym_id}`);
  item.setAttribute('data-gym-nav', g.gym_id);
  item.querySelector('.menu-item-text').textContent = g.gym_name || g.gym_id;
  const flag = item.querySelector('.psycle-menu-item-flag');
  const needs = g.status === 'needs_relogin';
  if (needs && !flag) {
    const f = document.createElement('span');
    f.className = 'psycle-menu-item-flag';
    f.title = COPY.settings.reconnectNeeded;
    f.textContent = '!';
    item.appendChild(f);
  } else if (!needs && flag) {
    flag.remove();
  }
}

function gymPaneCreate(g) {
  const pane = document.createElement('div');
  pane.className = 'psycle-settings-section-pane';
  pane.id = `psycle-settings-pane-gym-${g.gym_id}`;
  pane.setAttribute('data-gym-pane', g.gym_id);
  return pane;
}

/**
 * Paint (or repaint) everything that derives from the linked-gym list. Idempotent
 * and synchronous: safe to call from the boot context and again from the network
 * response, and safe under overlapping renders.
 */
function paintGyms(linked, { list, layout, menu, panesHost }) {
  connByGym = new Map(linked.map((g) => [g.gym_id, g]));

  const table = ensureConnTable(list);
  list.querySelector('.psycle-gym-conn-empty').hidden = linked.length > 0;
  table.hidden = linked.length === 0;
  reconcileKeyed(table, linked, {
    keyAttr: 'data-gym-key', keyOf: (g) => g.gym_id, create: connRowCreate, update: connRowUpdate,
  });

  // ── One sidebar entry and one pane PER GYM ─────────────────────────────────
  // A gym is a first-class section, so it gets a first-class nav entry (stacking
  // every gym's settings on one page meant scrolling past one gym's cards to
  // reach the next). Entries are keyed and reconciled, so an unlinked gym cannot
  // leave a dead entry behind and a surviving one keeps its `.active` state.
  if (!menu || !panesHost) return;
  const activeBefore = menu.querySelector('.active[data-gym-nav]')?.getAttribute('data-gym-nav');
  reconcileKeyed(menu, linked, {
    keyAttr: 'data-gym-nav', keyOf: (g) => g.gym_id, create: gymNavCreate, update: gymNavUpdate,
    // Gyms sit directly under "Your Gyms" and above "About".
    anchor: menu.querySelector('[data-settings-section="account"]'),
  });
  reconcileKeyed(panesHost, linked, { keyAttr: 'data-gym-pane', keyOf: (g) => g.gym_id, create: gymPaneCreate });
  // The gym whose pane was showing was unlinked: land on the connection table.
  if (activeBefore && !linked.some((g) => g.gym_id === activeBefore)) {
    layout?.__activateSettingsSection?.('gyms');
  }
}

async function onGymListClick(event) {
  const reauth = event.target.closest('[data-reauth-gym]');
  if (reauth) {
    const gymId = reauth.dataset.reauthGym;
    openLinkGymModal(gymId, connByGym.get(gymId));
    return;
  }
  const btn = event.target.closest('[data-unlink-gym]');
  if (!btn) return;

  // Double-click confirm, matching how every other destructive action in the app
  // behaves (cancel a booking, leave a waitlist).
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = COPY.settings.confirmUnlink;
    clearTimeout(btn._armTimer);
    btn._armTimer = setTimeout(() => { delete btn.dataset.armed; btn.textContent = COPY.settings.unlink; }, 4000);
    return;
  }
  clearTimeout(btn._armTimer);
  btn.disabled = true;
  try {
    await api.unlinkGym(btn.dataset.unlinkGym);
    showToast(COPY.settings.gymUnlinked, 'success');
    // C3-1: unlinking changes the linked-gym set the header badges and
    // capability gates read (client/src/gym-context.js), which settings.js
    // re-rendering its own cards never refreshes — without this the header
    // still shows the unlinked gym's badge until a full reload. loadGymContext()
    // updates the linked-gym list capability gates read; refreshUserData()
    // is what actually re-renders the header credit badges from that list
    // (updateCreditBadge reads getLinkedGyms()).
    await syncAfterGymSetChange();
    await renderGymsCard();
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    delete btn.dataset.armed;
    btn.textContent = COPY.settings.unlink;
  }
}

export /**
 * C3-15 / C3-26: everything that must refresh when the linked-gym SET changes
 * (link, re-auth, unlink). Sequenced: refreshUserData reads the linked-gym list
 * loadGymContext just set, and the timetable refetch needs both. The unscoped
 * studio-preferences cache entry (used only with <=1 gym) is dropped so going
 * from 2 gyms to 1 cannot serve the two-gym merge for 5 minutes.
 */
async function syncAfterGymSetChange() {
  await loadGymContext();
  await invalidateApiCache('/api/studio-preferences').catch(() => {});
  await refreshUserData(true);
  window.dispatchEvent(new CustomEvent('psycle:gyms-changed'));
  // Fire and forget: the fetch can take seconds and the settings panel must not wait.
  resetTimetableForGymChange().catch(() => {});
}

async function renderGymsCard() {
  const token = gymsRenderGuard.begin();
  const card = document.getElementById('psycle-gyms-card');
  const list = document.getElementById('psycle-gyms-list');
  const actions = document.getElementById('psycle-gyms-actions');
  const layout = document.getElementById('psycle-settings-layout-wrapper');
  const menu = layout?.querySelector('.psycle-settings-menu');
  const panesHost = layout?.querySelector('.psycle-settings-section-panes');
  if (!list) return;
  const els = { list, layout, menu, panesHost };

  // The card is ALWAYS shown, at every gym count. It used to hide itself when
  // exactly one gym was linked — and since the "Add a gym" button lives inside
  // it, a single-gym account had no way to link a second one at all.
  if (card) card.hidden = false;
  if (!list.dataset.gymHandlers) {
    list.dataset.gymHandlers = '1';
    list.addEventListener('click', onGymListClick);
  }

  // The old single inline host is no longer used; keep it empty so a stale render
  // can't linger behind the per-gym panes.
  const legacyInline = document.getElementById('psycle-gym-settings-section');
  if (legacyInline) { legacyInline.hidden = true; legacyInline.innerHTML = ''; }

  // ── Phase 1, synchronous: paint from the gyms the app already knows ────────
  const known = getLinkedGyms() || [];
  const painted = known.length > 0;
  if (painted) paintGyms(known, els);

  // ── Phase 2: enrich in place from the server (health, last authenticated) ──
  let linked;
  try {
    linked = (await api.getMyGyms()).gyms || [];
  } catch (err) {
    if (!gymsRenderGuard.isCurrent(token)) return;
    if (painted) debugConsole('[Settings] Could not refresh gym connections:', err.message);
    else list.innerHTML = `<div class="psycle-empty-state" style="padding:12px;">${getIsOffline() ? COPY.settings.noSavedGymData : formatCopyText(COPY.settings.couldNotLoadGyms, { error: escapeHtml(err.message) })}</div>`;
    return;
  }
  if (!gymsRenderGuard.isCurrent(token)) return;
  paintGyms(linked, els);

  // Only offer gyms that are both enabled and not already linked.
  let addable = [];
  try {
    const all = await api.getGyms();
    const linkedIds = new Set(linked.map(g => g.gym_id));
    addable = all.filter(g => g.enabled && !linkedIds.has(g.id));
  } catch (_) { /* catalogue is best-effort — the rest of the card still works */ }
  if (!gymsRenderGuard.isCurrent(token)) return;

  actions.innerHTML = addable.length
    ? `<button class="psycle-btn primary psycle-btn-mini" id="psycle-add-gym-btn">${COPY.settings.connectGymAction}</button>`
    : `<p class="psycle-card-desc" style="margin:0;">${COPY.settings.noAvailableGyms}</p>`;
  const addBtn = document.getElementById('psycle-add-gym-btn');
  if (addBtn) addBtn.onclick = () => openLinkGymModal(null, null, addable);

  // ── Phase 3: each gym's own settings pane (its content is the slow part) ───
  // Sequential, not Promise.all: each section fetches settings, membership and
  // credits for its gym, and firing them all at once against a rate-limited
  // provider is how you turn a settings page into a 429. The menu entries above
  // are already on screen, so this only ever fills panes in.
  if (!panesHost) return;
  for (const g of linked) {
    if (!gymsRenderGuard.isCurrent(token)) return;
    const pane = Array.from(panesHost.querySelectorAll('[data-gym-pane]')).find((p) => p.getAttribute('data-gym-pane') === g.gym_id);
    if (!pane) continue;
    await renderGymSettingsSection(g.gym_id, pane)
      .catch(err => debugConsole('[Settings] Gym section failed:', g.gym_id, err.message));
  }
}

// NOTE: `openGymSettingsDrawer()` used to live here and is deliberately gone.
// Per-gym settings render inline (see renderGymsCard above). The drawer was a
// fixed-position overlay with its own backdrop, and any modal launched from
// inside it — the spot-map editor in particular — painted BELOW that backdrop.
// Do not reintroduce a drawer or any other overlay layer for gym settings.

// One renderer for every setting owned by a gym. Phase 2 mounts the active gym
// inline in the existing Booking pane; Phase 3 can call this same function from
// an n=1 inline section or an n>=2 drawer without recreating any controls.
export async function renderGymSettingsSection(requestedGymId = null, targetContainer = null) {
  const container = targetContainer || document.getElementById('psycle-gym-settings-section');
  if (!container) return;

  // Keep already-rendered content while a refresh runs (U1-7: panes now persist
  // across renders); the placeholder is only for a pane that has nothing yet.
  if (!container.hasChildNodes()) {
    container.innerHTML = `<div class="psycle-settings-card"><p class="psycle-card-desc">${COPY.settings.loadingGymSettings}</p></div>`;
  }

  try {
    const [myGyms, catalogue] = await Promise.all([api.getMyGyms(), api.getGyms()]);
    const linked = myGyms.gyms || [];
    // No server-persisted "active gym" any more (stage 4 of the active-gym
    // audit) — `linked[0]` is the same deterministic default `loadGymContext()`
    // uses, so this and `userSettings`'s own gym stay in agreement.
    const gymId = requestedGymId || linked[0]?.gym_id;
    const link = linked.find(g => g.gym_id === gymId);
    if (!gymId || !link) {
      container.innerHTML = `<div class="psycle-settings-card"><h4>${COPY.settings.connectGym}</h4><p class="psycle-card-desc">${COPY.settings.linkBeforeConfig}</p></div>`;
      return;
    }

    const config = catalogue.find(g => g.id === gymId) || {};
    const gym = { ...config, ...link, id: gymId, capabilities: { ...(config.capabilities || {}), ...(link.capabilities || {}) } };
    const addable = catalogue.filter(g => g.enabled && !linked.some(item => item.gym_id === g.id));
    const [settings, membership, credits] = await Promise.all([
      api.getSettings(gymId),
      api.getMembership(gymId).catch(() => null),
      api.getNormalizedCredits(gymId).catch(() => []),
    ]);
    const bookingWindowText = describeBookingWindow(getBookingOffset(settings), null);

    const rerender = () => renderGymSettingsSection(gymId).catch(err => debugConsole('[Settings] Gym section refresh failed:', err.message));
    renderGymSettingsSectionView(container, {
      gym,
      settings,
      membership,
      credits,
      bookingWindowText,
      debugMode: !!userSettings.debugMode,
      canAddGym: linked.length === 1 && addable.length > 0,
    }, {
      onSettingChange: async (key, value, input) => {
        input.disabled = true;
        const normalizedValue = key === 'manualBookingWindowWeeks' && value != null ? Number(value) : value;
        const next = { ...settings, [key]: normalizedValue };
        try {
          // Only the changed key, against THIS section's gym.
          await api.updateSettings({ [key]: normalizedValue }, gymId);
          Object.assign(settings, next);
          // C3-18: mirror into the in-memory copy KEYED BY GYM. This used to
          // compare against `getLinkedGyms()[0]` on the theory that it was the
          // gym the server defaults to, but /api/my-gyms sorts by gym_id, so [0]
          // is jab-boxing while the server default is psycle-london: the mirror
          // landed on the wrong gym's copy. Position says nothing about identity.
          cache.gymSettings[gymId] = { ...(cache.gymSettings[gymId] || {}), ...next };
          showToast(formatCopyText(COPY.settings.gymSettingsSaved, { gym: gym.name || gymId }), 'success');
        } catch (err) {
          showToast(formatCopyText(COPY.settings.gymSettingsSaveFailed, { gym: gym.name || gymId, error: err.message }), 'error');
          rerender();
        } finally {
          input.disabled = false;
        }
      },
      onAction: async (action, button) => {
        if (action === 'reauth') return openLinkGymModal(gymId, link);
        if (action === 'add-gym') return openLinkGymModal(null, null, addable);
        if (action === 'spot-maps') return openManageSpotMapsModal({ gymId });
        if (action === 'profile') return openProfileExplorerModal(gymId, gym.name || link.gym_name);
        if (action === 'buy-credits') {
          document.querySelector('[data-tab="buy-credits"]')?.click();
          return;
        }
        if (action === 'unlink') {
          if (button.dataset.confirmState !== 'confirm') {
            button.dataset.confirmState = 'confirm';
            button.textContent = COPY.settings.confirmUnlink;
            setTimeout(() => {
              if (button.dataset.confirmState === 'confirm') {
                delete button.dataset.confirmState;
                button.textContent = COPY.settings.unlinkGym;
              }
            }, 4000);
            return;
          }
          button.disabled = true;
          try {
            await api.unlinkGym(gymId);
                await clearApiCache().catch(() => {});
            showToast(COPY.settings.gymUnlinked, 'success');
            // C3-1: see the other unlink handler above — the global gym context
            // (header badges, capability gates) must refresh too, not just this
            // panel's own card.
            await syncAfterGymSetChange();
            container.closest('.psycle-gym-settings-overlay')?.remove();
            await renderGymsCard();
          } catch (err) {
            showToast(formatCopyText(COPY.settings.unlinkFailed, { error: err.message }), 'error');
            button.disabled = false;
          }
          return;
        }

        // No remaining async gym actions fall through to here; calendar moved
        // to the account-level section (ui/calendar-section.js).
      },
    });
  } catch (err) {
    container.innerHTML = `<div class="psycle-${getIsOffline() ? 'empty-state' : 'card-error'}" style="padding:12px;">${getIsOffline() ? COPY.settings.noSavedGymSettings : formatCopyText(COPY.settings.loadGymSettingsFailed, { error: escapeHtml(err.message) })}</div>`;
  }
}

// One modal for both "add a gym" and "re-authenticate an existing one" — they are
// the same operation server-side (prove the credential, then store it), so making
// them two dialogs would just be two things to keep in step.
function openLinkGymModal(gymId, existing, addable = []) {
  const { body, title, open, close } = gymModal();
  const isReauth = !!gymId;
  title.textContent = isReauth
    ? formatCopyText(COPY.settings.reauthenticateGym, { gym: existing?.gym_name || gymId })
    : COPY.settings.addGym;

  body.innerHTML = `
    <p class="psycle-card-desc" style="margin-top:0;">
      ${isReauth
        ? COPY.settings.addGymCredentialsHelp
        : COPY.settings.linkGymCredentialsHelp}
    </p>
    ${isReauth ? '' : `
      <label class="psycle-setting-label" style="display:block;margin-bottom:4px;"><span>${COPY.settings.gym}</span></label>
      <select id="psycle-link-gym-id" class="psycle-select" style="width:100%;margin-bottom:10px;">
        ${addable.map(g => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join('')}
      </select>`}
    <label class="psycle-setting-label" style="display:block;margin-bottom:4px;"><span>${COPY.settings.email}</span></label>
    <input id="psycle-link-gym-email" type="email" class="psycle-input" autocomplete="username"
           style="width:100%;margin-bottom:10px;" placeholder="${COPY.static.exampleEmail}">
    <label class="psycle-setting-label" style="display:block;margin-bottom:4px;"><span>${COPY.settings.password}</span></label>
    <input id="psycle-link-gym-password" type="password" class="psycle-input" autocomplete="current-password"
           style="width:100%;margin-bottom:14px;">
    <div id="psycle-link-gym-error" style="display:none;color:var(--danger);font-size:12px;margin-bottom:10px;"></div>
    <button class="psycle-btn primary" id="psycle-link-gym-submit" style="width:100%;">
      ${isReauth ? COPY.settings.reauthenticate : COPY.settings.link}
    </button>
  `;
  open();

  const errEl = body.querySelector('#psycle-link-gym-error');
  const submit = body.querySelector('#psycle-link-gym-submit');
  submit.onclick = async () => {
    const targetGym = isReauth ? gymId : body.querySelector('#psycle-link-gym-id')?.value;
    const email = body.querySelector('#psycle-link-gym-email').value.trim();
    const password = body.querySelector('#psycle-link-gym-password').value;
    errEl.style.display = 'none';
    if (!targetGym || !email || !password) {
      errEl.textContent = COPY.auth.requiredGymCredentials;
      errEl.style.display = 'block';
      return;
    }
    submit.disabled = true;
    submit.textContent = COPY.settings.checking;
    try {
      await api.linkGym(targetGym, email, password);
      showToast(isReauth ? COPY.settings.reauthenticated : COPY.settings.gymLinked, 'success');
      close();
      // C3-1: a newly linked gym must appear in the header badges and pass
      // through capability gates immediately, not just in this panel's cards —
      // loadGymContext() updates the linked-gym list, refreshUserData() re-renders
      // the header credit badges from it (same pair the unlink handlers now use).
      // Sequenced (not Promise.all) because refreshUserData reads the linked-gym
      // list loadGymContext just set.
      syncAfterGymSetChange().catch(() => {});
      Promise.all([renderGymsCard(), renderGymSettingsSection(isReauth ? gymId : targetGym)]).catch(() => {});
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      submit.disabled = false;
      submit.textContent = isReauth ? COPY.settings.reauthenticate : COPY.settings.link;
    }
  };
}

function openAccountPasswordModal() {
  const { body, title, open, close } = gymModal();
  title.textContent = COPY.settings.changeAccountPassword;
  body.innerHTML = `
    <p class="psycle-card-desc" style="margin-top:0;">
      ${formatCopyText(COPY.settings.accountPasswordDescription, { appName: escapeHtml(appConfig.appName) })}
    </p>
    <label class="psycle-setting-label" style="display:block;margin-bottom:4px;"><span>${COPY.settings.currentPassword}</span></label>
    <input id="psycle-pw-current" type="password" class="psycle-input" autocomplete="current-password"
           style="width:100%;margin-bottom:10px;">
    <label class="psycle-setting-label" style="display:block;margin-bottom:4px;"><span>${COPY.settings.newPassword}</span></label>
    <input id="psycle-pw-new" type="password" class="psycle-input" autocomplete="new-password"
           style="width:100%;margin-bottom:10px;" placeholder="${COPY.settings.newPasswordMinPlaceholder}">
    <label class="psycle-setting-label" style="display:block;margin-bottom:4px;"><span>${COPY.settings.confirmNewPassword}</span></label>
    <input id="psycle-pw-confirm" type="password" class="psycle-input" autocomplete="new-password"
           style="width:100%;margin-bottom:14px;">
    <div id="psycle-pw-error" style="display:none;color:var(--danger);font-size:12px;margin-bottom:10px;"></div>
    <button class="psycle-btn primary" id="psycle-pw-submit" style="width:100%;">${COPY.settings.changePassword}</button>
  `;
  open();

  const errEl = body.querySelector('#psycle-pw-error');
  const submit = body.querySelector('#psycle-pw-submit');
  const fail = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

  submit.onclick = async () => {
    errEl.style.display = 'none';
    const current = body.querySelector('#psycle-pw-current').value;
    const next = body.querySelector('#psycle-pw-new').value;
    const confirm = body.querySelector('#psycle-pw-confirm').value;
    if (next.length < 8) return fail(COPY.settings.passwordMinimumError);
    if (next !== confirm) return fail(COPY.settings.passwordMismatchError);
    submit.disabled = true;
    submit.textContent = COPY.settings.changePasswordSaving;
    try {
      await api.changeAccountPassword(current, next);
      showToast(COPY.settings.accountPasswordChanged, 'success');
      close();
    } catch (err) {
      fail(err.message);
      submit.disabled = false;
      submit.textContent = COPY.settings.changePasswordButton;
    }
  };
}

// U1-10: a leading SVG glyph on each static Settings entry. Injected here (from the
// shared cards.js icon set) rather than pasted into index.html so the sidebar uses
// exactly the same stroke, size and currentColor rules as every other icon in the
// app. Idempotent; per-gym entries lead with the gym's own mark instead (U1-8).
const SETTINGS_MENU_ICONS = { general: 'sliders', calendar: 'calendar', notifications: 'bell', account: 'user', gyms: 'link', about: 'info' };
export function decorateSettingsMenu() {
  document.querySelectorAll('.psycle-settings-menu > [data-settings-section]').forEach((item) => {
    const name = SETTINGS_MENU_ICONS[item.getAttribute('data-settings-section')];
    if (!name || item.querySelector('.menu-item-lead')) return;
    const lead = document.createElement('span');
    lead.className = 'menu-item-lead';
    lead.innerHTML = icon(name, 18);
    item.insertBefore(lead, item.firstChild);
  });
}

/**
 * Open one gym's own Settings pane (header gym chips use this). Settings must
 * already be the visible tab. The gym's sidebar entry and pane are created by
 * renderGymsCard, so wait briefly for them rather than assuming they exist; on
 * mobile activateSection also drills into the pane, so Back / swipe-back work
 * exactly as after tapping the entry.
 */
export async function openGymSettings(gymId) {
  const layout = document.getElementById('psycle-settings-layout-wrapper');
  if (!layout) return;
  for (let i = 0; i < 40; i++) {
    const item = [...layout.querySelectorAll('[data-gym-nav]')].find((el) => el.getAttribute('data-gym-nav') === String(gymId));
    if (item && layout.__activateSettingsSection) { layout.__activateSettingsSection(`gym-${gymId}`); return; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function initSettings() {
  decorateSettingsMenu();
  loadSettingsInputs();
  setupSettingsListeners();
  setupThemeToggle();
  setupNotificationPrefs();
  updateTestNotifCardVisibility();
  // Konami listener is attached on first profile explorer modal open via setupExplorerKonamiListener()
  updatePushStatusUI();
  // Your Gyms card (WP-C2) — fire-and-forget: it renders its own loading and
  // error states, and a failure here must not stop the rest of Settings binding.
  renderGymsCard().catch(err => debugConsole('[Settings] Gyms card failed:', err.message));
  if (!window.__gymCatListener) {
    window.__gymCatListener = true;
    // Catalogue arriving after Settings first rendered: rebuild so the gym marks stop being neutral placeholders.
    window.addEventListener('gym-catalogue-ready', () => { renderGymsCard().catch(() => {}); });
  }
  // Account-level calendar feed (General tab) — same fire-and-forget rationale.
  renderCalendarSection().catch(err => debugConsole('[Settings] Calendar section failed:', err.message));
  // Spot Maps section is ready; button opens the modal
  setupSettingsNavigation();
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
  { key: 'booking', title: COPY.settings.notificationSpotBooked, desc: COPY.settings.notificationSpotBookedHelp,
    dropdown: { prop: 'scope', options: [['all', COPY.settings.allBookings], ['autobook', COPY.settings.autoBookOnly]] } },
  { key: 'upgrade', title: COPY.settings.notificationSpotUpgraded, desc: COPY.settings.notificationSpotUpgradedHelp },
  { key: 'creditWarning', title: COPY.settings.notificationCreditWarning, desc: COPY.settings.notificationCreditWarningHelp },
  { key: 'cancellationReminder', title: COPY.settings.notificationCancellationReminder, desc: COPY.settings.notificationCancellationHelp,
    dropdown: { prop: 'timing', options: [['24h', COPY.settings.cancellationDayBefore], ['14h', COPY.settings.beforePenalty]] } },
  // Per gym: only a gym that releases at one moment a week has a "window" to
  // warn about, so each gym carries its own default (gyms.config.js) and the
  // member can override either way.
  { key: 'bookingWindow', title: COPY.settings.notificationBookingWindow, desc: COPY.settings.notificationBookingWindowHelp, perGym: true },
];

/**
 * Is this gym's reminder on — the member's override, else the gym's own default.
 * Mirrors `notifications.bookingWindowEnabledForGym` on the server; the toggle
 * has to show the state the member would actually get.
 */
function perGymPrefOn(pref, gym) {
  const gymId = gym.gym_id || gym.id;
  // Rolling / per-class windows have no periodic release: always off (mirrors the server).
  if (!gymHasPeriodicWindow(gym)) return false;
  const override = (pref.byGym || {})[gymId];
  if (typeof override === 'boolean') return override;
  return gym.notifications?.bookingWindowReminder !== false;
}

/** A gym with a periodic ('rolling-weekly') booking window — from the gym's capability data, never its id. */
function gymHasPeriodicWindow(gym) {
  return gym?.capabilities?.bookingWindow === 'rolling-weekly';
}

/**
 * One sub-toggle per linked gym, shown under the parent row.
 *
 * Rendered even for a single-gym account: the default differs per gym, so
 * "Booking Window Reminder: on" with no gym named would be a half-truth the
 * moment a second gym is linked.
 */
function renderPerGymToggles(key, parentPref) {
  const gyms = getLinkedGyms() || [];
  if (gyms.length === 0) return '';
  return `
    <div class="notif-pergym-wrap" data-key="${key}" style="${parentPref.enabled ? '' : 'opacity:0.4;pointer-events:none;'}margin-top:10px;padding-top:10px;border-top:1px solid color-mix(in srgb, var(--text) 8%, transparent);">
      ${gyms.map((g) => {
        const gymId = g.gym_id || g.id;
        const locked = key === 'bookingWindow' && !gymHasPeriodicWindow(g);
        return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:4px 0;${locked ? 'opacity:0.45;' : ''}">
          <span style="font-size:12px;color:var(--text-secondary);">${getGymShortName(gymId) || gymId}${locked ? `<br><small style="font-size:11px;color:var(--text-tertiary);">${COPY.settings.bookingWindowRollingNote}</small>` : ''}</span>
          <label class="psycle-switch" style="flex-shrink:0;">
            <input type="checkbox" class="notif-pergym-toggle" data-key="${key}" data-gym-id="${gymId}" ${locked ? 'disabled' : ''} ${perGymPrefOn(parentPref, g) ? 'checked' : ''}>
            <span class="psycle-slider"></span>
          </label>
        </div>`;
      }).join('')}
    </div>`;
}

/** The booking-window reminder applies only if at least one linked gym has a periodic window. */
function anyPeriodicGym() { return (getLinkedGyms() || []).some(gymHasPeriodicWindow); }

function renderNotifPrefs() {
  const body = document.getElementById('psycle-notif-prefs-body');
  if (!body) return;
  const prefs = getNotifPrefs();

  body.innerHTML = `
    <p style="font-size:12px;color:var(--text-secondary);margin:0 0 16px;line-height:1.5;">${COPY.notifications.customizePush}</p>
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
              <input type="checkbox" class="notif-toggle" data-key="${row.key}" ${row.perGym && !anyPeriodicGym() ? 'disabled' : ''} ${p.enabled && !(row.perGym && !anyPeriodicGym()) ? 'checked' : ''}>
              <span class="psycle-slider"></span>
            </label>
          </div>
          ${dd ? `<div class="notif-dropdown-wrap" data-key="${row.key}" style="${p.enabled ? '' : 'opacity:0.4;pointer-events:none;'}">${dd}</div>` : ''}
          ${row.perGym ? renderPerGymToggles(row.key, p) : ''}
        </div>`;
    }).join('')}
  `;

  body.querySelectorAll('.notif-toggle').forEach(el => {
    el.addEventListener('change', () => {
      // The master switch dims its dependants — a per-gym toggle means nothing
      // while the notification type itself is off.
      for (const sel of ['.notif-dropdown-wrap', '.notif-pergym-wrap']) {
        const wrap = body.querySelector(`${sel}[data-key="${el.dataset.key}"]`);
        if (wrap) { wrap.style.opacity = el.checked ? '' : '0.4'; wrap.style.pointerEvents = el.checked ? '' : 'none'; }
      }
      saveNotifPrefs();
    });
  });
  body.querySelectorAll('.notif-dropdown').forEach(el => {
    el.addEventListener('change', saveNotifPrefs);
  });
  body.querySelectorAll('.notif-pergym-toggle').forEach(el => {
    el.addEventListener('change', saveNotifPrefs);
  });
}

async function saveNotifPrefs() {
  const body = document.getElementById('psycle-notif-prefs-body');
  if (!body) return;
  const prefs = getNotifPrefs();
  body.querySelectorAll('.notif-toggle:not(:disabled)').forEach(el => {
    prefs[el.dataset.key].enabled = el.checked;
  });
  body.querySelectorAll('.notif-dropdown').forEach(el => {
    prefs[el.dataset.key][el.dataset.prop] = el.value;
  });
  // Every gym is written explicitly, including ones left at their default:
  // storing only the differences would silently flip a member's choice if the
  // gym's own default ever changed.
  body.querySelectorAll('.notif-pergym-toggle').forEach(el => {
    const p = prefs[el.dataset.key];
    p.byGym = { ...(p.byGym || {}), [el.dataset.gymId]: el.checked };
  });

  userSettings.notifications = prefs;
  try {
    await api.updateSettings({ notifications: prefs }); // account-scoped
  } catch (err) {
    showToast(formatCopyText(COPY.settings.notificationSaveFailed, { error: err.message }), 'error');
  }
}

function setupNotificationPrefs() {
  const openBtn = document.getElementById('psycle-notif-prefs-btn');
  const modal = document.getElementById('psycle-notif-prefs-modal');
  const closeBtn = document.getElementById('psycle-notif-prefs-close');
  debugConsole('[setupNotificationPrefs] openBtn:', openBtn, 'modal:', modal, 'closeBtn:', closeBtn);
  if (openBtn && !openBtn.dataset.listener) {
    openBtn.dataset.listener = 'true';
    openBtn.addEventListener('click', () => {
      debugConsole('[notif-btn-click] renderNotifPrefs and showing modal');
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
        showToast(COPY.notifications.pushTestSent, 'success');
      } catch (err) {
        showToast(formatCopyText(COPY.settings.pushTestFailed, { error: err.message }), 'error');
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

function loadSettingsInputs() {
  const debugMode = document.getElementById('psycle-setting-debug-mode');
  const prefetchWeeks = document.getElementById('psycle-setting-prefetch-weeks');

  if (debugMode) debugMode.checked = !!userSettings.debugMode;
  if (prefetchWeeks) prefetchWeeks.value = String(userSettings.prefetchWeeks || 4);
}

function setupSettingsListeners() {
  const debugMode = document.getElementById('psycle-setting-debug-mode');
  const prefetchWeeks = document.getElementById('psycle-setting-prefetch-weeks');

  const accountPasswordBtn = document.getElementById('psycle-account-password-btn');
  if (accountPasswordBtn && !accountPasswordBtn.dataset.listener) {
    accountPasswordBtn.dataset.listener = 'true';
    accountPasswordBtn.addEventListener('click', openAccountPasswordModal);
  }

  const saveSettings = async () => {
    // Spread existing settings first so unmanaged keys (notifications, cartInstanceId,
    // detectedBookingOffset) survive.
    // Both account-scoped, so no gym is involved — and only these two are sent.
    const newSettings = {
      debugMode: debugMode ? debugMode.checked : false,
      prefetchWeeks: prefetchWeeks ? parseInt(prefetchWeeks.value) : 4
    };

    try {
      await api.updateSettings(newSettings);
      Object.assign(userSettings, newSettings);
      updateTestNotifCardVisibility();
      // U1-3: this used to only take effect on the next reload — the terminal
      // stayed exactly as it was (shown or hidden) until then, because nothing
      // called this after a save. debugLog() itself forces the terminal
      // visible as a side effect of logging, which is what made toggling ON
      // look "sometimes work": the very next network call papered over it.
      updateDebugTerminalVisibility();
      renderGymSettingsSection().catch(() => {});
      showToast(COPY.settings.settingsSaved, 'success');
    } catch (err) {
      showToast(formatCopyText(COPY.settings.settingsSaveFailed, { error: err.message }), 'error');
    }
  };

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
        showToast(COPY.settings.configExporting, 'info');
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
        
        showToast(COPY.settings.configExported, 'success');
      } catch (err) {
        showToast(formatCopyText(COPY.settings.exportFailed, { error: err.message }), 'error');
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
          
          showToast(COPY.settings.importingConfig, 'info');
          const result = await api.importConfig(config);
          showToast(COPY.settings.configImported, 'success');
          // Anything not restored (an unlinked gym, or an old backup with no gym on its per-gym keys).
          (result?.skipped || []).forEach((m) => showToast(m, 'warning'));
          
          // Clear file input
          importFileInput.value = '';
          
          // Reload settings and update UI
          setTimeout(() => {
            window.location.reload();
          }, (result?.skipped || []).length ? 6000 : 1200);

        } catch (err) {
          showToast(formatCopyText(COPY.settings.importFailed, { error: err.message }), 'error');
        }
      };
      reader.readAsText(file);
    });
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
      showToast(COPY.settings.loggingOut, 'info');
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
        deleteDataBtn.textContent = COPY.settings.confirmDelete;
        deleteDataBtn.style.background = 'var(--danger)';
        deleteDataBtn.style.color = 'var(--on-accent)';
        deleteDataBtn.style.borderColor = 'var(--danger)';
        setTimeout(() => {
          if (deleteDataBtn.dataset.confirmState === 'confirm') {
            delete deleteDataBtn.dataset.confirmState;
            deleteDataBtn.textContent = COPY.settings.deleteData;
            deleteDataBtn.style.background = '';
            deleteDataBtn.style.color = '';
            deleteDataBtn.style.borderColor = '';
          }
        }, 5000);
        return;
      }
      delete deleteDataBtn.dataset.confirmState;
      deleteDataBtn.disabled = true;
      deleteDataBtn.textContent = COPY.settings.deleting;
      try {
        await apiFetch('/api/auth/me', { method: 'DELETE' });
        showToast(COPY.settings.allDataDeleted, 'success');
        localStorage.removeItem('psycleLocalToken');
        setTimeout(() => { window.location.reload(); }, 1500);
      } catch (err) {
        showToast(formatCopyText(COPY.settings.deleteFailed, { error: err.message }), 'error');
        deleteDataBtn.disabled = false;
        deleteDataBtn.textContent = COPY.settings.deleteData;
      }
    });
  }
}
