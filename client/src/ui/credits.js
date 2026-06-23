import { api, isLoggedIn } from '../api';
import { showToast, cache } from '../main';

// Use same localStorage key as Chrome Extension for cross-compatibility.
// Default is [792] (CRM bundle) — same as extension default.
let favorites = [];
try {
  const storedFavs = localStorage.getItem('psycle-helper-favorites');
  if (storedFavs) {
    favorites = JSON.parse(storedFavs);
  } else {
    favorites = [792];
    localStorage.setItem('psycle-helper-favorites', JSON.stringify(favorites));
  }
} catch (e) {
  favorites = [792];
}

export async function initBundles() {
  const container = document.getElementById('psycle-bundles-container');
  if (!container) return;

  // Add search/filter listeners if we're rendering first time
  setupFilterListeners();

  // Alert about experimental checkout (only insert once)
  if (!document.querySelector('.psycle-credits-alert')) {
    const alertDiv = document.createElement('div');
    alertDiv.className = 'psycle-credits-alert';
    alertDiv.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-start; padding:12px 14px; background:color-mix(in srgb, var(--warning) 15%, transparent); border:1px solid var(--warning); border-radius:10px;">
        <div style="font-size:20px; flex-shrink:0; line-height:1;">⚠</div>
        <div style="flex:1; font-size:12px; color:color-mix(in srgb, var(--warning) 100%, #000); line-height:1.5;">
          <div style="font-weight:700; margin-bottom:4px;">EXPERIMENTAL</div>
          <div>Purchasing bundles works but is not well-tested. This app sends the order directly to Psycle using your saved cards, so it never sees your payment data. It doesn't support 3-D Secure, so payments might fail.</div>
        </div>
      </div>
    `;
    container.parentElement.insertBefore(alertDiv, container);
  }

  container.innerHTML = `
    <div class="psycle-loading-spinner-container">
      <div class="psycle-spinner"></div>
      <span>Loading bundles...</span>
    </div>
  `;

  try {
    if (cache.bundles.length === 0) {
      const res = await api.proxyGet('/bundles', { ttlMs: 3600000 });
      cache.bundles = res.data || res || [];
    }
    
    renderBundles();
  } catch (err) {
    console.error('Failed to load bundles:', err);
    if (cache.bundles.length === 0) {
      container.innerHTML = '<div class="psycle-empty-state" style="text-align:center;padding:40px 20px;color:var(--text-secondary)"><p style="font-size:16px;margin-bottom:8px">No cached data available</p><p style="font-size:13px;color:var(--text-tertiary)">Connect to the internet to load credit bundles.</p></div>';
    }
  }

}

function getFilterEls() {
  return {
    returning: document.getElementById('psycle-filter-returning'),
    studios: document.getElementById('psycle-filter-studios'),
    home: document.getElementById('psycle-filter-home'),
    student: document.getElementById('psycle-filter-student'),
    topup: document.getElementById('psycle-filter-topup'),
    unlimited: document.getElementById('psycle-filter-unlimited'),
    weird: document.getElementById('psycle-filter-weird'),
    location: document.getElementById('psycle-filter-location'),
    toggleBtn: document.getElementById('psycle-toggle-bundle-filters'),
    filtersContainer: document.getElementById('psycle-bundles-checkbox-filters'),
  };
}

function setupFilterListeners() {
  const searchInput = document.getElementById('psycle-bundle-search');

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
      els.toggleBtn.textContent = shown ? 'Filters' : 'Hide Filters';
    });
  }

  // Attach change listeners to all filter checkboxes
  const filterIds = ['returning', 'studios', 'home', 'student', 'topup', 'unlimited', 'weird', 'location'];
  filterIds.forEach(key => {
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

function matchesFilterRules(b) {
  const name = b.name.toLowerCase();
  const handle = b.handle ? b.handle.toLowerCase() : '';
  const desc = b.description ? b.description.toLowerCase() : '';
  const terms = b.metafields?.terms ? b.metafields.terms.toLowerCase() : '';
  const textScope = `${name} ${handle} ${desc} ${terms}`;

  const filters = getFilterEls();

  // === ALWAYS-ON RULES (no checkbox — always hide these from the view) ===

  // NOT CUSTOMER FACING (direct name check for robustness — catches bundle ID 792)
  if (name.includes('not customer facing')) return false;

  // Intro/welcome offers
  if (textScope.includes('introductory offer') || textScope.includes('intro credit') || textScope.includes('welcome offer')) return false;

  // Advanced Booking Credit (special credit type, not a regular bundle)
  if (textScope.includes('advanced booking credit') || textScope.includes('advanced booking')) return false;

  // Single Credit full-price bundles (hide single-class purchases, keep offers like £15 First Class)
  if (textScope.includes('single credit')) return false;

  // Partner bundles
  if (textScope.includes('soho house') || textScope.includes('trade partners') || textScope.includes('itsu')) return false;

  // Class-specific bundles
  if (textScope.includes('ride credit') || textScope.includes('barre credit') || textScope.includes('yoga credit') || textScope.includes('strength credit') || textScope.includes('lagree')) return false;

  // Event-specific bundles
  if (textScope.includes('barre & brunch') || textScope.includes('ride & rosé') || textScope.includes('ride lounge') || textScope.includes('move & meet')) return false;

  // 1. Returning customers only (Excludes intro packs, is_first_purchase_only)
  if (filters.returning?.checked) {
    if (b.is_first_purchase_only || name.includes('intro pack') || name.includes('intro offer') || name.includes('welcome offer')) {
      return false;
    }
  }

  // 2. All studios only (Excludes studio-specific bundles)
  if (filters.studios?.checked) {
    if (!isValidAllStudios(b)) return false;
  }

  // 3. Hide At-Home / Online credits
  if (filters.home?.checked) {
    if (name.includes('at home') || name.includes('at-home') || handle.includes('home') || name.includes('online')) {
      return false;
    }
  }

  // 4. Hide student / member / graduate / corp credits
  if (filters.student?.checked) {
    if (textScope.includes('student') || textScope.includes('u27') || textScope.includes('member') || textScope.includes('corp') || textScope.includes('graduate')) {
      return false;
    }
  }

  // 5. Hide Top ups / addons
  if (filters.topup?.checked) {
    if (textScope.includes('top up') || textScope.includes('top-up') || textScope.includes('addon')) {
      return false;
    }
  }

  // 6. Hide Unlimited / membership
  if (filters.unlimited?.checked) {
    if (b.is_unlimited || textScope.includes('unlimited') || textScope.includes('membership')) {
      return false;
    }
  }

  // 8. Hide Location-Specific bundles
  if (filters.location?.checked) {
    const locKeywords = ['victoria', 'clapham', 'notting hill', 'shoreditch', 'bank', 'oxford circus', 'london bridge', 'belgravia', 'london heritage'];
    for (const kw of locKeywords) {
      if (textScope.includes(kw)) return false;
    }
  }

  // 7. Hide weird / test / restricted / event / promotional bundles
  if (filters.weird?.checked) {
    if (b.price === 0) return false;

    const keywords = [
      'test', 'staff', 'dummy', 'free',
      'friends & family', 'friends and family',
      'not customer facing',
      'gym flex', 'office',
      'global coach', 'headliner',
      'key worker',
      'sale:',
    ];
    for (const kw of keywords) {
      if (textScope.includes(kw)) return false;
    }

    // Past expiry date check (available_until field)
    if (b.available_until) {
      const availableDate = new Date(b.available_until);
      if (availableDate < new Date()) return false;
    }
  }

  return true;
}

export function renderBundles() {
  const container = document.getElementById('psycle-bundles-container');
  const searchInput = document.getElementById('psycle-bundle-search');

  const term = searchInput ? searchInput.value.toLowerCase().trim() : '';

  if (!container) return;

  // Filter
  let filtered = cache.bundles.filter(b => {
    // Basic clean filter
    if (!matchesFilterRules(b)) return false;

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
    container.innerHTML = '<div class="fav-empty-state">No bundles match the current filters.</div>';
    return;
  }

  container.innerHTML = '';

  // Render Favorites Section
  const favs = filtered.filter(b => favorites.includes(b.id));
  if (favs.length === 0) {
    // No favorites: show everything in a single grid
    const allGrid = document.createElement('div');
    allGrid.className = 'psycle-favorites-grid';
    filtered.forEach(b => {
      allGrid.appendChild(createBundleCard(b, false));
    });
    container.appendChild(allGrid);
  } else {
    // Show favorites grid + All Credits collapsible section
    const favHeader = document.createElement('div');
    favHeader.className = 'psycle-section-subheader';
    favHeader.innerHTML = '<h4>Favourite Bundles</h4>';
    container.appendChild(favHeader);

    const favGrid = document.createElement('div');
    favGrid.className = 'psycle-favorites-grid';
    favs.forEach(b => {
      favGrid.appendChild(createBundleCard(b, true));
    });
    container.appendChild(favGrid);

    const allHeader = document.createElement('div');
    allHeader.className = 'psycle-section-subheader';
    allHeader.innerHTML = '<h4>All Credits <span class="all-credits-chevron" style="font-size:12px; margin-left:8px;">▶&#xFE0E;</span></h4>';
    container.appendChild(allHeader);

    // Render Grid — collapsed by default
    const allGrid = document.createElement('div');
    allGrid.className = 'psycle-favorites-grid';
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
      if (chevron) chevron.textContent = isHidden ? '▼&#xFE0E;' : '▶&#xFE0E;';
    });
  }
}

function createBundleCard(b, isFavSection) {
  const isFav = favorites.includes(b.id);
  const allStudios = isValidAllStudios(b);
  const allClasses = isValidAllClasses(b);
  const costPerCredit = b.total_credits ? (b.price / b.total_credits / 100).toFixed(2) : 'N/A';
  const formattedPrice = `£${(b.price / 100).toFixed(2)}`;

  const card = document.createElement('div');
  card.className = 'fav-card';
  card.innerHTML = `
    <div class="fav-card-header">
      <div>
        <div class="fav-card-title">${b.name}</div>
        <div class="fav-card-handle" style="font-size: 12px; color: var(--text-tertiary); margin-top: 2px;">${b.handle} (ID: ${b.id})</div>
      </div>
      <button class="fav-card-star-btn ${isFav ? 'active' : ''}" title="${isFav ? 'Unpin' : 'Pin to favorites'}">
        ${isFav ? '★' : '☆'}
      </button>
    </div>
    <div class="fav-card-meta">
      <div class="fav-price">${formattedPrice}</div>
      <div class="fav-cost">£${costPerCredit} / credit</div>
    </div>
    <div class="fav-card-pills">
      <span class="badge-pill" style="text-transform:none;">${b.total_credits} Credits</span>
      <span class="badge-pill ${allStudios ? 'valid' : 'invalid'}">${allStudios ? 'All Studios' : 'Select Studios'}</span>
      <span class="badge-pill ${allClasses ? 'valid' : 'invalid'}">${allClasses ? 'All Workouts' : 'Excl. Lagree'}</span>
      <span class="badge-pill ${b.is_first_purchase_only ? 'badge-restricted' : 'badge-available'}">${b.is_first_purchase_only ? '1st Only' : '✔ Rtn Customer'}</span>
      <span class="badge-pill ${b.is_one_time_purchase_only ? 'badge-restricted' : 'badge-available'}">${b.is_one_time_purchase_only ? '1-Time' : '✔ Rpt Purchase'}</span>
    </div>
    <button class="psycle-btn-primary fav-card-buy-btn" style="margin-top: 12px; padding: 8px;">
      Buy ${formattedPrice}
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
function openPurchaseModal(b) {
  const unitPence = b.price;
  const unitLabel = `£${(unitPence / 100).toFixed(2)}`;

  const overlay = document.createElement('div');
  overlay.className = 'psycle-modal psycle-purchase-modal';
  overlay.innerHTML = `
    <div class="psycle-modal-overlay"></div>
    <div class="psycle-modal-card" style="width:420px; max-width:92vw;">
      <div class="psycle-modal-header" style="padding:14px 20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle);">
        <h4 class="psycle-checkout-title" style="margin:0; font-size:15px; font-weight:700; color:var(--text-primary);">Cart</h4>
        <button class="psycle-modal-close-btn" aria-label="Close">×</button>
      </div>
      <div class="psycle-purchase-body" style="padding:20px;"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => overlay.classList.add('show'), 10);

  const closeModal = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 300);
  };

  overlay.querySelector('.psycle-modal-overlay').addEventListener('click', closeModal);
  overlay.querySelector('.psycle-modal-close-btn').addEventListener('click', closeModal);

  const body = overlay.querySelector('.psycle-purchase-body');
  const titleEl = overlay.querySelector('.psycle-checkout-title');

  // ── Step 1: Cart ──────────────────────────────────────────────────────────
  let qty = 1;

  function renderCart() {
    const total = `£${((unitPence * qty) / 100).toFixed(2)}`;
    body.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
        <div style="flex:1; min-width:0; padding-right:12px;">
          <div style="font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${b.name}</div>
          <div style="font-size:12px; color:var(--text-tertiary); margin-top:3px;">${b.total_credits} credit${b.total_credits !== 1 ? 's' : ''} · ${unitLabel} each</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
          <button class="psycle-qty-btn psycle-qty-dec" style="width:28px; height:28px; border-radius:6px; border:1px solid var(--border-subtle); background:var(--surface-raised); color:var(--text-primary); font-size:16px; cursor:pointer; line-height:1;">−</button>
          <span class="psycle-qty-val" style="min-width:20px; text-align:center; font-weight:700; color:var(--text-primary);">${qty}</span>
          <button class="psycle-qty-btn psycle-qty-inc" style="width:28px; height:28px; border-radius:6px; border:1px solid var(--border-subtle); background:var(--surface-raised); color:var(--text-primary); font-size:16px; cursor:pointer; line-height:1;">+</button>
          <button class="psycle-qty-remove" title="Remove" style="margin-left:4px; background:none; border:none; color:var(--text-tertiary); font-size:18px; cursor:pointer; padding:2px 4px;">✕</button>
        </div>
      </div>
      <div style="border-top:1px solid var(--border-subtle); padding-top:12px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:13px; color:var(--text-secondary);">Total (inc. VAT)</span>
        <span class="psycle-cart-total" style="font-weight:700; font-size:16px; color:var(--text-primary);">${total}</span>
      </div>
      <button class="psycle-btn-primary psycle-checkout-btn" style="width:100%; padding:11px;">Continue to Payment →</button>
    `;

    body.querySelector('.psycle-qty-dec').addEventListener('click', () => {
      if (qty > 1) { qty--; renderCart(); }
    });
    body.querySelector('.psycle-qty-inc').addEventListener('click', () => {
      if (qty < 10) { qty++; renderCart(); }
    });
    body.querySelector('.psycle-qty-remove').addEventListener('click', closeModal);
    body.querySelector('.psycle-checkout-btn').addEventListener('click', () => proceedToPayment());
  }

  // ── Step 2: Payment ───────────────────────────────────────────────────────
  async function proceedToPayment() {
    titleEl.textContent = 'Payment';
    body.innerHTML = `
      <div class="psycle-loading-spinner-container">
        <div class="psycle-spinner"></div>
        <span>Loading saved cards…</span>
      </div>
    `;

    let instance, methods;
    try {
      const init = await api.checkoutInit(b.id, qty);
      instance = init.instance;
      methods = init.methods || [];
    } catch (err) {
      renderPurchaseError(body, b, `Couldn't load payment options: ${err.message}`);
      return;
    }

    if (methods.length === 0) {
      renderPurchaseError(body, b, 'No saved card found on your Psycle account.', 'Add a card on the Psycle website, then try again.');
      return;
    }

    const totalPence = unitPence * qty;
    const totalLabel = `£${(totalPence / 100).toFixed(2)}`;
    const defaultPm = methods.find(m => m.default) || methods[0];

    const cardOptions = methods.map(m => `
      <label class="psycle-pm-row" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border-subtle); border-radius:10px; margin-bottom:8px; cursor:pointer;">
        <input type="radio" name="psycle-pm" value="${m.id}" ${m.id === defaultPm.id ? 'checked' : ''}>
        <span style="text-transform:capitalize; font-weight:600; color:var(--text-primary);">${m.brand}</span>
        <span style="color:var(--text-secondary);">•••• ${m.last4}</span>
        <span style="margin-left:auto; font-size:12px; color:var(--text-tertiary);">${String(m.exp_month).padStart(2,'0')}/${m.exp_year}</span>
      </label>
    `).join('');

    body.innerHTML = `
      <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">Pay with</div>
      ${cardOptions}
      <div style="border-top:1px solid var(--border-subtle); margin:12px 0; padding-top:12px; display:flex; justify-content:space-between;">
        <span style="font-size:13px; color:var(--text-secondary);">${qty > 1 ? `${qty}× ${b.name}` : b.name}</span>
        <span style="font-weight:700; color:var(--text-primary);">${totalLabel}</span>
      </div>
      <button class="psycle-btn-primary psycle-pay-btn" style="width:100%; padding:11px;">Pay ${totalLabel}</button>
    `;

    body.querySelector('.psycle-pay-btn').addEventListener('click', async () => {
      const pmId = body.querySelector('input[name="psycle-pm"]:checked')?.value;
      if (!pmId) return;

      body.innerHTML = `
        <div class="psycle-loading-spinner-container">
          <div class="psycle-spinner"></div>
          <span>Processing payment…</span>
        </div>
      `;

      try {
        const result = await api.checkoutConfirm(instance, pmId);
        if (result.status === 'paid') {
          body.innerHTML = `
            <div style="text-align:center; padding:16px 0;">
              <div style="font-size:40px; margin-bottom:8px;">✅</div>
              <div style="font-weight:700; color:var(--text-primary);">Payment complete</div>
              <div style="font-size:13px; color:var(--text-secondary); margin-top:4px;">${b.total_credits * qty} credits added to your account.</div>
              <button class="psycle-btn-primary psycle-done-btn" style="margin-top:16px; padding:10px 24px;">Done</button>
            </div>
          `;
          body.querySelector('.psycle-done-btn').addEventListener('click', closeModal);
          showToast('Credits purchased!', 'success');
        } else if (result.status === 'requires_action') {
          renderPurchaseError(body, b,
            "This card needs 3-D Secure authentication, which isn't supported in-app yet.",
            null, true
          );
        } else {
          renderPurchaseError(body, b, result.error || 'The payment was declined.');
        }
      } catch (err) {
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
      <div style="font-weight:700; color:var(--text-primary); margin-bottom:6px;">Tips to avoid 3-D Secure</div>
      • Use a card your bank already trusts for Psycle.<br>
      • Complete one purchase on the Psycle website first — banks usually stop challenging after that.<br>
      • Amex cards are challenged less often than Visa/Mastercard.
    </div>
  ` : (hint ? `<div style="font-size:12px; color:var(--text-tertiary); margin-top:8px;">${hint}</div>` : '');

  body.innerHTML = `
    <div style="text-align:center; padding:8px 0;">
      <div style="font-size:36px; margin-bottom:8px;">⚠️</div>
      <div style="font-weight:700; color:var(--text-primary);">Payment not completed</div>
      <div style="font-size:13px; color:var(--text-secondary); margin-top:4px;">${message}</div>
      ${tips}
      <button class="psycle-btn-primary psycle-website-btn" style="margin-top:16px; padding:10px 20px;">Finish on Website</button>
    </div>
  `;
  body.querySelector('.psycle-website-btn').addEventListener('click', () => {
    const handle = b.handle || '';
    window.open(handle ? `https://psyclelondon.com/products/${handle}` : 'https://psyclelondon.com/', '_blank');
  });
}

function toggleFavorite(id) {
  const index = favorites.indexOf(id);
  if (index === -1) {
    favorites.push(id);
    showToast('Bundle pinned to favourites.', 'success');
  } else {
    favorites.splice(index, 1);
    showToast('Bundle unpinned.', 'info');
  }
  localStorage.setItem('psycle-helper-favorites', JSON.stringify(favorites));
  renderBundles();
}
