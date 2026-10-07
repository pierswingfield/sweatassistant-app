import { api, isLoggedIn } from '../api';
import { noSept } from '../lib';
import { getLinkedGyms } from '../gym-context.js';
import { gymChip } from './cards.js';
import { showToast, cache } from '../main';
import { COPY, formatCopyText } from '../copy.js';
import { openPage as openNavPage, closePage as closeNavPage } from './modal-nav.js';

// Use same localStorage key as Chrome Extension for cross-compatibility.
// Default is [792] (CRM bundle) — same as extension default.
let favorites = [];
try {
  const storedFavs = localStorage.getItem('app-helper-favorites');
  if (storedFavs) {
    favorites = JSON.parse(storedFavs);
  } else {
    favorites = [792];
    localStorage.setItem('app-helper-favorites', JSON.stringify(favorites));
  }
} catch (e) {
  favorites = [792];
}

// bundle_type relations (id → { handle, name }), populated from the /bundles response.
// Used to categorise bundles structurally for the "Show X" reveal toggles.
let bundleTypes = [];

// The gym this checkout flow targets (set in initBundles from `creditGym`) —
// this whole module is CodexFit/Shopify-specific (see the capability gate
// below), so its copy names the actual gym rather than assuming "Psycle".
// The fallback website URL stays literally Psycle's: this checkout flow only
// works against Psycle's Shopify storefront today (no other gym is
// creditPurchase-capable yet), so a "generic" URL here would be a lie, not a
// fix — see Documentation/Archive/2026-09-26/Backlog/multi-gym-buy-credits.md for the real fix.
let creditGymName = 'your gym';
let creditGymId = null;
let creditGymWebsiteUrl = null;

export async function initBundles() {
  const summaryRoot = document.getElementById('app-credits-summary');
  if (!summaryRoot) return;

  setupFilterListeners();
  setupCreditsBackButton();

  // `getLinkedGyms()` is the in-memory gym context, which is populated during
  // app start. Landing DIRECTLY on this tab (a deep link, a reload on
  // #buy-credits) can run this before that completes, and an empty list here is
  // indistinguishable from "no gyms linked" — so the page rendered "Connect a
  // gym" to an account with two. Fall back to asking the server before
  // concluding anything.
  let linked = getLinkedGyms() || [];
  if (linked.length === 0) {
    try {
      const [mine, catalogue] = await Promise.all([
        api.getMyGyms(),
        api.getGyms().catch(() => []),
      ]);
      // `/api/my-gyms` rows carry NO `capabilities` — that lives on the public
      // catalogue, and `getLinkedGyms()` merges the two during app start. Using
      // the bare rows made every gym look metered (`capabilities?.metered !==
      // false` is true when capabilities is undefined), so a membership gym
      // rendered "0 credits available — you cannot book until you top up",
      // which is both wrong and alarming.
      const byId = new Map((catalogue || []).map((g) => [g.id, g]));
      linked = (mine.gyms || []).map((g) => {
        const cfg = byId.get(g.gym_id) || {};
        return { ...cfg, ...g, capabilities: { ...(cfg.capabilities || {}), ...(g.capabilities || {}) } };
      });
    } catch (_) { /* leave empty; the message below is then the truth */ }
  }
  if (linked.length === 0) {
    summaryRoot.innerHTML = `<div class="app-card-desc" style="padding:20px 0;">${COPY.credits.connectGym}</div>`;
    return;
  }

  summaryRoot.innerHTML = linked.map(g => summaryCardSkeleton(g)).join('');

  // PROGRESSIVE, not all-or-nothing. This used to `await Promise.all([...])`
  // over both fan-outs before rendering anything, so the whole page waited on
  // the slowest gym's slowest call — and with two gyms that is four provider
  // round trips deep on a cold cache. Each card now replaces its own skeleton
  // the moment its own gym's data lands.
  const memberships = {};
  const creditsByGym = {};

  await Promise.all(linked.map(async (gym) => {
    const gymId = gym.gym_id || gym.id;
    const [membership, credits] = await Promise.all([
      api.getMembership(gymId).catch(() => null),
      api.getNormalizedCredits(gymId).catch(() => []),
    ]);
    memberships[gymId] = membership;
    creditsByGym[gymId] = credits;
    replaceSummaryCard(gym, membership, credits);
  }));

  // The hidden membership detail sections still want the whole map.
  renderMembershipSections(linked, memberships);
}

/** Swap ONE gym's skeleton for its real card, leaving the others alone. */
function replaceSummaryCard(gym, membership, credits) {
  const root = document.getElementById('app-credits-summary');
  if (!root) return;
  const gymId = gym.gym_id || gym.id;
  const existing = root.querySelector(`[data-gym="${CSS.escape(String(gymId))}"]`);
  if (!existing) return;
  const holder = document.createElement('div');
  holder.innerHTML = summaryCardHtml(gym, membership, credits);
  const card = holder.firstElementChild;
  if (!card) return;
  existing.replaceWith(card);
  wireSummaryCard(card);
}

/** A card's placeholder while its gym's numbers are in flight. */
function summaryCardSkeleton(gym) {
  const gymId = gym.gym_id || gym.id;
  return `<article class="app-benefit-card is-loading" data-gym="${escapeHtml(gymId)}">
    <div class="app-benefit-card-head">
      ${/* Shared builder — this used to hand-roll the chip with the gym's SHORT
            NAME as text. It picked up the brand background from the class name
            but never the wordmark, so the cards showed black text on the brand
            plate. Two places building the same chip will always drift. */ ''}
      ${gymChip(gymId)}
    </div>
    <div class="app-benefit-headline">…</div>
    <div class="app-card-desc">${COPY.credits.checkingAllowance}</div>
  </article>`;
}

/**
 * One card per connected gym: what you can book with, right now.
 *
 * Deliberately NOT one shape for both kinds of gym. A metered gym's answer is a
 * NUMBER that runs out and can be topped up; a membership gym's is a STATE with
 * a renewal date and nothing to buy. Forcing both into "credits" is what made a
 * JAB member read as having zero of something.
 *
 * Only a gym with somewhere to go is clickable — a card that looks interactive
 * and does nothing is worse than a flat one.
 */
/**
 * ONE gym's summary card.
 *
 * Deliberately NOT one shape for both kinds of gym. A metered gym's answer is a
 * NUMBER that runs out and can be topped up; a membership gym's is a STATE with
 * a renewal date and nothing to buy. Forcing both into "credits" is what made a
 * JAB member read as having zero of something.
 *
 * Only a gym with somewhere to go is clickable — a card that looks interactive
 * and does nothing is worse than a flat one.
 */
function summaryCardHtml(gym, membership, credits) {
  const gymId = gym.gym_id || gym.id;
  const canPurchase = gym.capabilities?.creditPurchase === true;
  const metered = gym.capabilities?.metered !== false;
  const list = credits || [];
  const total = list.reduce((sum, c) => sum + (Number(c.count) || 0), 0);

  let headline, sub;
  const facts = [];
  if (metered) {
    headline = `${total}`;
    sub = total === 1 ? COPY.credits.creditAvailableOne : COPY.credits.creditAvailableMany;
    // Surface the soonest expiry: a balance about to lapse is the one fact a
    // total alone hides.
    const next = list
      .filter(c => c.expiresAt && (Number(c.count) || 0) > 0)
      .sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt))[0];
    if (next) facts.push(COPY.credits.soonestExpiry.replace('{date}', formatMembershipDate(next.expiresAt)));
    if (total === 0) facts.push(COPY.credits.topUpRequired);
  } else if (membership) {
    headline = membership.isActive ? COPY.credits.member : COPY.credits.inactive;
    sub = membership.name || COPY.credits.membership;
    const renews = formatMembershipDate(membership.renewsAt);
    const expires = formatMembershipDate(membership.expiresAt);
    if (renews) facts.push(COPY.credits.renews.replace('{date}', renews));
    if (expires) facts.push(COPY.credits.expires.replace('{date}', expires));
    if (membership.bookingWindowLabel) facts.push(membership.bookingWindowLabel);
    if (Number.isFinite(Number(membership.guestPassesRemaining))) {
      facts.push(formatCopyText(Number(membership.guestPassesRemaining) === 1 ? COPY.gymSettings.guestPassesOne : COPY.gymSettings.guestPassesMany, { count: Number(membership.guestPassesRemaining) }));
    }
  } else {
    headline = '0';
    sub = COPY.credits.noMembership;
    facts.push(COPY.credits.membershipRequired);
  }

  const websiteUrl = membership?.manageUrl || gym.websiteUrl;
  const action = canPurchase
    ? `<button class="app-btn app-btn-mini primary" data-open-credit-gym="${escapeHtml(gymId)}">${COPY.credits.buyCredits}</button>`
    : websiteUrl
      ? `<a class="app-btn app-btn-mini" href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer">${COPY.credits.manageAtGym}</a>`
      : '';

  return `<article class="app-benefit-card${canPurchase ? ' is-actionable' : ''}" data-gym="${escapeHtml(gymId)}">
    <div class="app-benefit-card-head">
      ${/* Shared builder — this used to hand-roll the chip with the gym's SHORT
            NAME as text. It picked up the brand background from the class name
            but never the wordmark, so the cards showed black text on the brand
            plate. Two places building the same chip will always drift. */ ''}
      ${gymChip(gymId)}
      <span class="app-benefit-kind">${metered ? COPY.credits.creditsKind : COPY.credits.membershipKind}</span>
    </div>
    <div class="app-benefit-headline"><strong>${escapeHtml(headline)}</strong><span>${escapeHtml(sub)}</span></div>
    ${facts.length ? `<ul class="app-benefit-facts">${facts.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>` : ''}
    ${action ? `<div class="app-benefit-card-actions">${action}</div>` : ''}
  </article>`;
}

/** Click handlers for one card (re-applied whenever a card is replaced). */
function wireSummaryCard(card) {
  if (!card) return;
  const btn = card.querySelector('[data-open-credit-gym]');
  if (btn) btn.onclick = (e) => { e.stopPropagation(); openGymCreditDetail(btn.dataset.openCreditGym); };
  // The whole card is a target for a purchasable gym, so the click area matches
  // what the hover state implies.
  if (card.classList.contains('is-actionable')) {
    card.onclick = () => openGymCreditDetail(card.dataset.gym);
  }
}

function setupCreditsBackButton() {
  const back = document.getElementById('app-credits-back');
  if (!back || back.dataset.wired) return;
  back.dataset.wired = 'true';
  back.onclick = () => {
    document.getElementById('app-credits-detail').hidden = true;
    document.getElementById('app-credits-summary').hidden = false;
  };
}

/** Open ONE gym's bundle catalogue. */
async function openGymCreditDetail(gymId) {
  const linked = getLinkedGyms() || [];
  const gym = linked.find(g => (g.gym_id || g.id) === gymId);
  if (!gym) return;

  creditGymName = gym.shortName || gym.name || COPY.static.yourGymFallback;
  creditGymId = gymId;
  creditGymWebsiteUrl = gym.websiteUrl || null;

  document.getElementById('app-credits-summary').hidden = true;
  const detail = document.getElementById('app-credits-detail');
  detail.hidden = false;

  const purchaseHeading = document.getElementById('app-credit-purchase-heading');
  if (purchaseHeading) {
    purchaseHeading.innerHTML = `<div class="app-benefit-section-heading" data-gym="${escapeHtml(gymId)}">
      <div><span class="app-benefit-gym">${escapeHtml(gym.name || creditGymName)}</span><h4>${COPY.credits.creditBundles}</h4></div>
      <span class="app-benefit-kind">${COPY.credits.creditsKind}</span>
    </div>`;
  }

  if (!document.querySelector('.app-credits-alert')) {
    const alertDiv = document.createElement('div');
    alertDiv.className = 'app-credits-alert';
    alertDiv.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-start; padding:12px 14px; background:color-mix(in srgb, var(--warning) 15%, transparent); border:1px solid var(--warning); border-radius:10px; margin:12px 0;">
        <div style="font-size:20px; flex-shrink:0; line-height:1;">⚠</div>
        <div style="flex:1; font-size:12px; line-height:1.5;">
          <div style="font-weight:700; margin-bottom:4px;">${COPY.credits.experimental}</div>
          <div>${COPY.credits.experimentalPurchaseNotice.replace('{gymName}', escapeHtml(creditGymName))}</div>
        </div>
      </div>`;
    purchaseHeading.insertAdjacentElement('afterend', alertDiv);
  }

  const container = document.getElementById('app-bundles-container');
  container.innerHTML = `
    <div class="app-loading-spinner-container">
      <div class="app-spinner"></div>
      <span>${COPY.credits.loadingBundles}</span>
    </div>`;

  try {
    if (cache.bundles.length === 0) {
      // Credit packs are a metered-gym concept. A membership gym has nothing to
      // sell here, so the route is capability-gated server-side (501 for a gym
      // without `creditPurchase`) — but the path is the app's, not CodexFit's.
      const res = await api.getBundles({ gymId, ttlMs: 3600000 });
      cache.bundles = res.bundles || [];
      if (res.bundleTypes) bundleTypes = res.bundleTypes;
    }
    renderBundles();
  } catch (err) {
    console.error('Failed to load bundles:', err);
    container.innerHTML = `<div class="app-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">${COPY.credits.noCachedBundles}</p><p style="font-size:13px;color:var(--text-tertiary)">${COPY.credits.loadBundlesHelp}</p></div>`;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMembershipDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : noSept(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date));
}

function renderMembershipSections(linked, memberships) {
  const root = document.getElementById('app-membership-sections');
  if (!root) return;

  const membershipGyms = linked.filter((g) => g.capabilities?.creditPurchase !== true);
  if (membershipGyms.length === 0) {
    root.innerHTML = '';
    return;
  }

  root.innerHTML = membershipGyms.map((gym) => {
    const gymId = gym.gym_id || gym.id;
    const membership = memberships[gymId];
    const websiteUrl = membership?.manageUrl || gym.websiteUrl;
    const expiry = formatMembershipDate(membership?.expiresAt);
    const renewal = formatMembershipDate(membership?.renewsAt);
    const guestText = membership?.guestPassesRemaining != null
      ? `${membership.guestPassesRemaining}${membership.guestPassesTotal != null ? ` of ${membership.guestPassesTotal}` : ''} guest passes remaining`
      : null;
    const facts = [renewal && COPY.credits.renews.replace('{date}', renewal), expiry && COPY.credits.expires.replace('{date}', expiry),
      membership?.bookingWindowLabel, guestText].filter(Boolean);

    return `<section class="app-membership-section" data-gym="${escapeHtml(gymId)}">
      <div class="app-benefit-section-heading">
        <div><span class="app-benefit-gym">${escapeHtml(gym.name || gym.shortName || gymId)}</span><h4>${COPY.credits.membershipKind}</h4></div>
        <span class="app-membership-status ${membership?.isActive ? 'is-active' : 'is-inactive'}">
          ${escapeHtml(membership?.isActive ? COPY.credits.member : COPY.credits.notActive)}
        </span>
      </div>
      <div class="app-membership-card">
        <div>
          <div class="app-membership-name">${escapeHtml(membership?.name || COPY.credits.activeMembershipMissing)}</div>
          ${facts.length ? `<div class="app-membership-facts">${facts.map(escapeHtml).join(' · ')}</div>` : ''}
          <div class="app-membership-note">${formatCopyText(COPY.credits.managedByGym, { gym: escapeHtml(gym.shortName || gym.name || COPY.static.yourGymFallback) })}</div>
        </div>
        ${websiteUrl ? `<a class="app-btn-mini app-membership-manage" href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener noreferrer">${COPY.credits.openWebsite}</a>` : ''}
      </div>
    </section>`;
  }).join('');
}

// The four "Show X" reveal toggles. Each is OFF by default, so its category is hidden
// until the user opts to show it. Keyed by the group returned from bundleGroup().
const SHOW_TOGGLE_IDS = {
  singleTopup: 'app-show-single-topup',
  studioLocation: 'app-show-studio-location',
  memberStudent: 'app-show-member-student',
  introPromo: 'app-show-intro-promo',
};

function getFilterEls() {
  return {
    singleTopup: document.getElementById(SHOW_TOGGLE_IDS.singleTopup),
    studioLocation: document.getElementById(SHOW_TOGGLE_IDS.studioLocation),
    memberStudent: document.getElementById(SHOW_TOGGLE_IDS.memberStudent),
    introPromo: document.getElementById(SHOW_TOGGLE_IDS.introPromo),
    toggleBtn: document.getElementById('app-toggle-bundle-filters'),
    filtersContainer: document.getElementById('app-bundles-checkbox-filters'),
  };
}

function setupFilterListeners() {
  const searchInput = document.getElementById('app-bundle-search');

  if (searchInput && !searchInput.dataset.listenerAttached) {
    searchInput.dataset.listenerAttached = 'true';
    searchInput.addEventListener('input', () => {
      renderBundles();
      // Auto-expand All Credits when searching
      const allSection = document.querySelector('[data-section-id="all"]');
      if (searchInput.value.trim() && allSection) {
        allSection.classList.add('expanded');
      }
    });
  }

  // Lazy-init filter toggle button + checkbox listeners on first interaction
  const els = getFilterEls();
  if (els.toggleBtn && !els.toggleBtn.dataset.listenerAttached) {
    els.toggleBtn.dataset.listenerAttached = 'true';
    els.toggleBtn.addEventListener('click', () => {
      const container = els.filtersContainer;
      if (!container) return;
      const shown = container.style.display !== 'none';
      container.style.display = shown ? 'none' : 'flex';
      els.toggleBtn.textContent = shown ? COPY.credits.categories : COPY.credits.hideCategories;
    });
  }

  // Attach change listeners to the "Show X" reveal toggles.
  Object.keys(SHOW_TOGGLE_IDS).forEach(key => {
    const cb = els[key];
    if (cb && !cb.dataset.listenerAttached) {
      cb.dataset.listenerAttached = 'true';
      cb.addEventListener('change', renderBundles);
    }
  });
}

// Bundle filter helpers (matching extension rules)
function isValidAllStudios(b) {
  return !b.studio_id && (!b.studios || b.studios.length === 0);
}

function isValidAllClasses(b) {
  return !b.class_type_id && (!b.class_types || b.class_types.length === 0);
}

// Resolve a bundle's bundle_type handle (e.g. 'top-up', 'student', 'oxford-circus').
// Empty string if relations are unavailable — callers fall back to text matching.
function bundleTypeHandle(b) {
  const t = bundleTypes.find(t => t.id === b.bundle_type_id);
  return (t?.handle || '').toLowerCase();
}

// Location-specific bundle_type handles (one per studio).
const LOCATION_HANDLES = ['oxford-circus', 'notting-hill', 'clapham', 'shoreditch', 'victoria', 'bank', 'london-bridge'];
const LOCATION_KEYWORDS = ['victoria', 'clapham', 'notting hill', 'shoreditch', 'bank', 'oxford circus', 'london bridge', 'belgravia', 'london heritage'];

// Categorise a bundle into one of the four gated "Show X" groups, or null if it belongs
// in the default view (general PAYG packs, class-specific credits, advanced booking).
// Primary signal is the structural bundle_type handle; text rules are a fallback.
// Order matters — the first matching group wins.
function bundleGroup(b) {
  const name = b.name.toLowerCase();
  const handle = b.handle ? b.handle.toLowerCase() : '';
  const desc = b.description ? b.description.toLowerCase() : '';
  const terms = b.metafields?.terms ? b.metafields.terms.toLowerCase() : '';
  const textScope = `${name} ${handle} ${desc} ${terms}`;
  // name+handle only — avoids restriction notes like "Not valid on Lagree" false-positiving.
  const nameScope = `${name} ${handle}`;
  const th = bundleTypeHandle(b);

  // Single credits & top-ups
  if (th === 'top-up' || nameScope.includes('single credit') || nameScope.includes('top up')
      || nameScope.includes('top-up') || nameScope.includes('addon')) {
    return 'singleTopup';
  }

  // Studio & location-specific (incl. at-home / online)
  if (LOCATION_HANDLES.includes(th) || LOCATION_KEYWORDS.some(k => nameScope.includes(k))
      || nameScope.includes('at home') || nameScope.includes('at-home') || nameScope.includes('online')) {
    return 'studioLocation';
  }

  // Member, student & corporate
  if (['student', 'staff', 'corporate-offers-1', 'members'].includes(th)
      || /student|u27|member|corp|graduate|unlimited|membership/.test(textScope)
      || b.is_unlimited) {
    return 'memberStudent';
  }

  // Intro, promo & other (welcome offers, partners, events, test/staff/free, expired, £0)
  const isExpired = b.available_until && new Date(b.available_until) < new Date();
  if (['intro', 'promotion-credits', 'seasonal-promotion', 'key-worker', 'crm', 'partners'].includes(th)
      || b.is_first_purchase_only || b.price === 0 || isExpired
      || /introductory offer|intro credit|intro pack|intro offer|welcome offer/.test(nameScope)
      || /soho house|trade partners|itsu/.test(nameScope)
      || /barre & brunch|ride & rosé|ride lounge|move & meet/.test(nameScope)
      || /\btest\b|\bdummy\b|\bfree\b|friends & family|friends and family|gym flex|office|global coach|headliner|sale:/.test(textScope)) {
    return 'introPromo';
  }

  return null; // default-visible
}

function matchesFilterRules(b, searching = false) {
  const name = b.name.toLowerCase();

  // Truly internal — never shown, even when searching or favourited.
  if (name.includes('not customer facing')) return false;

  // Search and pinned favourites both reveal everything customer-facing.
  if (searching || favorites.includes(b.id)) return true;

  // Default browse: show general/class-specific/advanced-booking bundles. Anything in a
  // gated group is hidden unless the user has flipped that group's "Show X" toggle on.
  const group = bundleGroup(b);
  if (!group) return true;
  return !!getFilterEls()[group]?.checked;
}

// Shown instead of the bundle grid for a gym that doesn't sell credit packs.
// The tab is hidden by the capability gate, so this is the belt-and-braces path
// for anyone who deep-links to #buy-credits.
function renderNoPurchaseState() {
  const container = document.getElementById('app-bundles-container');
  if (!container) return;
  container.innerHTML = `
    <div style="text-align:center;padding:32px 24px;color:var(--text-secondary);">
      <div style="font-size:32px;margin-bottom:12px;">\u{1F39F}\u{FE0F}</div>
      <p style="margin:0;font-weight:600;color:var(--text);">${COPY.credits.noCreditPacks}</p>
      <p style="font-size:13px;margin:8px 0 0;">${COPY.credits.membershipTopUpDescription}</p>
    </div>
  `;
}

export function renderBundles() {
  const container = document.getElementById('app-bundles-container');
  const searchInput = document.getElementById('app-bundle-search');

  const term = searchInput ? searchInput.value.toLowerCase().trim() : '';

  if (!container) return;

  // Filter. An active search bypasses the curated browse declutter so any bundle is findable.
  const searching = term.length > 0;
  let filtered = cache.bundles.filter(b => {
    // Basic clean filter
    if (!matchesFilterRules(b, searching)) return false;

    // Search term matching name, id, or handle (matching extension logic)
    const matchesSearch = b.name.toLowerCase().includes(term) || String(b.id).includes(term) || (b.handle && b.handle.toLowerCase().includes(term));
    if (!matchesSearch) return false;

    return true;
  });

  // Sort: Favorites first, then alphabetical by name
  filtered.sort((a, b) => {
    const aFav = favorites.includes(a.id);
    const bFav = favorites.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;
    return a.name.localeCompare(b.name);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="fav-empty-state">${COPY.credits.noBundleMatches}</div>`;
    return;
  }

  container.innerHTML = '';

  // Render Favorites Section
  const favs = filtered.filter(b => favorites.includes(b.id));
  if (favs.length === 0) {
    // No favorites: show everything in a single grid
    const allGrid = document.createElement('div');
    allGrid.className = 'app-favorites-grid';
    filtered.forEach(b => {
      allGrid.appendChild(createBundleCard(b, false));
    });
    container.appendChild(allGrid);
  } else {
    // Show favorites grid + All Credits collapsible section
    const favHeader = document.createElement('div');
    favHeader.className = 'app-section-subheader';
    favHeader.innerHTML = `<h4>${COPY.credits.favouriteBundles}</h4>`;
    container.appendChild(favHeader);

    const favGrid = document.createElement('div');
    favGrid.className = 'app-favorites-grid';
    favs.forEach(b => {
      favGrid.appendChild(createBundleCard(b, true));
    });
    container.appendChild(favGrid);

    const allHeader = document.createElement('div');
    allHeader.className = 'app-section-subheader';
    allHeader.innerHTML = `<h4>${COPY.credits.allCredits} <span class="all-credits-chevron" style="font-size:12px; margin-left:8px;">▶\uFE0E</span></h4>`;
    container.appendChild(allHeader);

    // Render Grid — collapsed by default
    const allGrid = document.createElement('div');
    allGrid.className = 'app-favorites-grid';
    allGrid.style.display = 'none';
    filtered.forEach(b => {
      if (!favorites.includes(b.id)) {
        allGrid.appendChild(createBundleCard(b, false));
      }
    });
    container.appendChild(allGrid);

    // Toggle collapsible
    allHeader.addEventListener('click', () => {
      const isHidden = allGrid.style.display === 'none';
      allGrid.style.display = isHidden ? '' : 'none';
      const chevron = allHeader.querySelector('.all-credits-chevron');
      if (chevron) chevron.textContent = isHidden ? '▼\uFE0E' : '▶\uFE0E';
    });
  }
}

function createBundleCard(b, isFavSection) {
  const isFav = favorites.includes(b.id);
  const allStudios = isValidAllStudios(b);
  const allClasses = isValidAllClasses(b);
  const costPerCredit = b.total_credits ? (b.price / b.total_credits / 100).toFixed(2) : COPY.credits.notAvailable;
  const formattedPrice = `£${(b.price / 100).toFixed(2)}`;

  const card = document.createElement('div');
  card.className = 'fav-card';
  card.innerHTML = `
    <div class="fav-card-header">
      <div>
        <div class="fav-card-title">${b.name}</div>
        <div class="fav-card-handle" style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">${b.handle} ${formatCopyText(COPY.credits.bundleId, { id: b.id })}</div>
      </div>
      <button class="fav-card-star-btn ${isFav ? 'active' : ''}" title="${isFav ? COPY.credits.unpinBundle : COPY.credits.pinBundle}">
        ${isFav ? '★' : '☆'}
      </button>
    </div>
    <div class="fav-card-meta">
      <div class="fav-price">${formattedPrice}</div>
      <div class="fav-cost">£${costPerCredit} ${COPY.credits.creditUnit}</div>
    </div>
    <div class="fav-card-pills">
      <span class="badge-pill" style="text-transform:none;">${formatCopyText(COPY.credits.creditsCount, { count: b.total_credits })}</span>
      <span class="badge-pill ${allStudios ? 'valid' : 'invalid'}">${allStudios ? COPY.credits.allStudios : COPY.credits.selectStudios}</span>
      <span class="badge-pill ${allClasses ? 'valid' : 'invalid'}">${allClasses ? COPY.credits.allWorkouts : COPY.credits.excludesLagree}</span>
      <span class="badge-pill ${b.is_first_purchase_only ? 'badge-restricted' : 'badge-available'}">${b.is_first_purchase_only ? COPY.credits.firstOnly : COPY.credits.returningCustomer}</span>
      <span class="badge-pill ${b.is_one_time_purchase_only ? 'badge-restricted' : 'badge-available'}">${b.is_one_time_purchase_only ? COPY.credits.oneTime : COPY.credits.repeatPurchase}</span>
    </div>
    <button class="app-btn-primary fav-card-buy-btn" style="margin-top: 12px; padding: 8px;">
      ${formatCopyText(COPY.credits.buyFor, { price: formattedPrice })}
    </button>
  `;

  // Star Pin button click handler
  card.querySelector('.fav-card-star-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(b.id);
  });

  // In-app purchase: charge a saved card without leaving the app.
  card.querySelector('.fav-card-buy-btn').addEventListener('click', () => openPurchaseModal(b));

  return card;
}

// In-app checkout modal. Two steps:
//   1. Cart — bundle name, qty stepper, line total. No API call yet.
//   2. Payment — load saved cards, select, pay.
// 3-D Secure is not supported: if the off-session charge needs authentication
// we surface a graceful error with tips and a website fallback.
export function openPurchaseModal(b) {
  const unitPence = b.price;
  const unitLabel = `£${(unitPence / 100).toFixed(2)}`;

  const overlay = document.createElement('div');
  overlay.className = 'app-modal app-purchase-modal';
  overlay.innerHTML = `
    <div class="app-modal-overlay"></div>
    <div class="app-modal-card" style="width:420px; max-width:92vw;">
      <div class="app-modal-header" style="padding:14px 20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle);">
        <h4 class="app-checkout-title" style="margin:0; font-size:15px; font-weight:700; color:var(--text-primary);">${COPY.credits.cart}</h4>
        <button class="app-modal-close-btn" aria-label="${COPY.credits.closeModal}">×</button>
      </div>
      <div class="app-purchase-body" style="padding:20px;"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Mobile page. While a charge is in flight the page cannot be dismissed: X is hidden
  // (CSS, `.is-busy`) and a back gesture is swallowed (the helper re-pushes the entry).
  let chargeInFlight = false;
  const setBusy = (v) => { chargeInFlight = v; overlay.classList.toggle('is-busy', v); };
  openNavPage(overlay, { id: 'checkout', remove: true, canClose: () => !chargeInFlight });

  const closeModal = () => {
    if (closeNavPage(overlay)) return; // mobile: pops the page (guard skipped)
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  };

  overlay.querySelector('.app-modal-overlay').addEventListener('click', closeModal);
  overlay.querySelector('.app-modal-close-btn').addEventListener('click', closeModal);

  const body = overlay.querySelector('.app-purchase-body');
  const titleEl = overlay.querySelector('.app-checkout-title');

  // ── Step 1: Cart ──────────────────────────────────────────────────────────
  let qty = 1;

  function renderCart() {
    const total = `£${((unitPence * qty) / 100).toFixed(2)}`;
    body.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
        <div style="flex:1; min-width:0; padding-right:12px;">
          <div style="font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${b.name}</div>
          <div style="font-size:12px; color:var(--text-tertiary); margin-top:3px;">${formatCopyText(COPY.credits.creditBreakdown, { count: b.total_credits, plural: b.total_credits !== 1 ? 's' : '', price: unitLabel })}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
          <button class="app-qty-btn app-qty-dec" style="width:28px; height:28px; border-radius:6px; border:1px solid var(--border-subtle); background:var(--surface-raised); color:var(--text-primary); font-size:16px; cursor:pointer; line-height:1;">−</button>
          <span class="app-qty-val" style="min-width:20px; text-align:center; font-weight:700; color:var(--text-primary);">${qty}</span>
          <button class="app-qty-btn app-qty-inc" style="width:28px; height:28px; border-radius:6px; border:1px solid var(--border-subtle); background:var(--surface-raised); color:var(--text-primary); font-size:16px; cursor:pointer; line-height:1;">+</button>
          <button class="app-qty-remove" title="${COPY.credits.remove}" style="margin-left:4px; background:none; border:none; color:var(--text-tertiary); font-size:18px; cursor:pointer; padding:2px 4px;">✕</button>
        </div>
      </div>
      <div style="border-top:1px solid var(--border-subtle); padding-top:12px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px; color:var(--text-secondary);">${COPY.credits.totalIncVat}</span>
        <span class="app-cart-total" style="font-weight:700; font-size:16px; color:var(--text-primary);">${total}</span>
      </div>
      <button class="app-btn-primary app-checkout-btn" style="width:100%; padding:11px;">${COPY.credits.continueToPayment}</button>
    `;

    body.querySelector('.app-qty-dec').addEventListener('click', () => {
      if (qty > 1) { qty--; renderCart(); }
    });
    body.querySelector('.app-qty-inc').addEventListener('click', () => {
      if (qty < 10) { qty++; renderCart(); }
    });
    body.querySelector('.app-qty-remove').addEventListener('click', closeModal);
    body.querySelector('.app-checkout-btn').addEventListener('click', () => proceedToPayment());
  }

  // ── Step 2: Payment ───────────────────────────────────────────────────────
  async function proceedToPayment() {
    titleEl.textContent = COPY.credits.payment;
    body.innerHTML = `
      <div class="app-loading-spinner-container">
        <div class="app-spinner"></div>
        <span>${COPY.credits.loadingSavedCards}</span>
      </div>
    `;

    let instance, methods;
    try {
      const init = await api.checkoutInit(b.id, qty, creditGymId);
      instance = init.instance;
      methods = init.methods || [];
    } catch (err) {
      renderPurchaseError(body, b, formatCopyText(COPY.credits.paymentOptionsFailed, { error: err.message }));
      return;
    }

    if (methods.length === 0) {
      renderPurchaseError(body, b, formatCopyText(COPY.credits.noSavedCard, { gym: creditGymName }), formatCopyText(COPY.credits.addCardHint, { gym: creditGymName }));
      return;
    }

    const totalPence = unitPence * qty;
    const totalLabel = `£${(totalPence / 100).toFixed(2)}`;
    const defaultPm = methods.find(m => m.default) || methods[0];

    const cardOptions = methods.map(m => `
      <label class="app-pm-row" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border-subtle); border-radius:10px; margin-bottom:8px; cursor:pointer;">
        <input type="radio" name="app-pm" value="${m.id}" ${m.id === defaultPm.id ? 'checked' : ''}>
        <span style="text-transform:capitalize; font-weight:600; color:var(--text-primary);">${m.brand}</span>
        <span style="color:var(--text-secondary);">•••• ${m.last4}</span>
        <span style="margin-left:auto; font-size:12px; color:var(--text-tertiary);">${String(m.exp_month).padStart(2,'0')}/${m.exp_year}</span>
      </label>
    `).join('');

    body.innerHTML = `
      <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">${COPY.credits.payWith}</div>
      ${cardOptions}
      <div style="border-top:1px solid var(--border-subtle); margin:12px 0; padding-top:12px; display:flex; justify-content:space-between;">
        <span style="font-size:13px; color:var(--text-secondary);">${qty > 1 ? `${qty}× ${b.name}` : b.name}</span>
        <span style="font-weight:700; color:var(--text-primary);">${totalLabel}</span>
      </div>
      <button class="app-btn-primary app-pay-btn" style="width:100%; padding:11px;">${formatCopyText(COPY.credits.payTotal, { total: totalLabel })}</button>
    `;

    body.querySelector('.app-pay-btn').addEventListener('click', async () => {
      const pmId = body.querySelector('input[name="app-pm"]:checked')?.value;
      if (!pmId) return;

      body.innerHTML = `
        <div class="app-loading-spinner-container">
          <div class="app-spinner"></div>
          <span>${COPY.credits.processingPayment}</span>
        </div>
      `;

      setBusy(true);
      try {
        const result = await api.checkoutConfirm(instance, pmId, creditGymId);
        setBusy(false);
        if (result.status === 'paid') {
          body.innerHTML = `
            <div style="text-align:center; padding:16px 0;">
              <div style="font-size:40px; margin-bottom:8px;">✅</div>
              <div style="font-weight:700; color:var(--text-primary);">${COPY.credits.paymentComplete}</div>
              <div style="font-size:13px; color:var(--text-secondary); margin-top:4px;">${formatCopyText(COPY.credits.creditsAdded, { count: b.total_credits * qty })}</div>
              <button class="app-btn-primary app-done-btn" style="margin-top:16px; padding:10px 24px;">${COPY.credits.done}</button>
            </div>
          `;
          body.querySelector('.app-done-btn').addEventListener('click', closeModal);
          showToast(COPY.credits.creditsPurchased, 'success');
        } else if (result.status === 'requires_action') {
          renderPurchaseError(body, b,
            COPY.credits.unsupportedSecureCard,
            null, true
          );
        } else {
          renderPurchaseError(body, b, result.error || COPY.credits.declined);
        }
      } catch (err) {
        setBusy(false);
        renderPurchaseError(body, b, err.message);
      }
    });
  }

  renderCart();
}

// Error state — shown inline inside the modal body.
// secureTips=true adds concise guidance for 3DS issues + website fallback.
function renderPurchaseError(body, b, message, hint, secureTips) {
  const tips = secureTips ? `
    <div style="text-align:left; background:var(--surface-raised); border:1px solid var(--border-subtle); border-radius:10px; padding:12px; margin-top:14px; font-size:12px; color:var(--text-secondary); line-height:1.6;">
      <div style="font-weight:700; color:var(--text-primary); margin-bottom:6px;">${COPY.credits.avoidsThreeDSecure}</div>
      • ${COPY.credits.cardTrustedTip.replace('{gymName}', escapeHtml(creditGymName))}<br>
      • ${COPY.credits.websitePurchaseTip.replace('{gymName}', escapeHtml(creditGymName))}<br>
      • ${COPY.credits.amexTip}
    </div>
  ` : (hint ? `<div style="font-size:12px; color:var(--text-tertiary); margin-top:8px;">${hint}</div>` : '');

  body.innerHTML = `
    <div style="text-align:center; padding:8px 0;">
      <div style="font-size:36px; margin-bottom:8px;">⚠️</div>
      <div style="font-weight:700; color:var(--text-primary);">${COPY.credits.paymentNotCompleted}</div>
      <div style="font-size:13px; color:var(--text-secondary); margin-top:4px;">${message}</div>
      ${tips}
      <button class="app-btn-primary app-website-btn" style="margin-top:16px; padding:10px 20px;">${COPY.credits.finishOnWebsite}</button>
    </div>
  `;
  body.querySelector('.app-website-btn').addEventListener('click', () => {
    const handle = b.handle || '';
    if (!creditGymWebsiteUrl) return;
    const target = handle ? new URL(`products/${handle}`, creditGymWebsiteUrl).toString() : creditGymWebsiteUrl;
    window.open(target, '_blank', 'noopener,noreferrer');
  });
}

function toggleFavorite(id) {
  const index = favorites.indexOf(id);
  if (index === -1) {
    favorites.push(id);
    showToast(COPY.credits.bundlePinned, 'success');
  } else {
    favorites.splice(index, 1);
    showToast(COPY.credits.bundleUnpinned, 'info');
  }
  localStorage.setItem('app-helper-favorites', JSON.stringify(favorites));
  renderBundles();
}
