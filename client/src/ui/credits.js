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

  container.innerHTML = `
    <div class="psycle-loading-spinner-container">
      <div class="psycle-spinner"></div>
      <span>Loading bundles...</span>
    </div>
  `;

  try {
    if (cache.bundles.length === 0) {
      const res = await api.proxyGet('/bundles');
      cache.bundles = res.data || res || [];
    }
    
    renderBundles();
  } catch (err) {
    console.error('Failed to load bundles:', err);
    container.innerHTML = `<div class="psycle-card-error">Failed to load bundles: ${err.message}</div>`;
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
  const favToggle = document.getElementById('psycle-bundle-favorites-only');

  if (searchInput && !searchInput.dataset.listenerAttached) {
    searchInput.dataset.listenerAttached = 'true';
    searchInput.addEventListener('input', renderBundles);
  }
  if (favToggle && !favToggle.dataset.listenerAttached) {
    favToggle.dataset.listenerAttached = 'true';
    favToggle.addEventListener('change', renderBundles);
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
  const favToggle = document.getElementById('psycle-bundle-favorites-only');

  const term = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const favsOnly = favToggle ? favToggle.checked : false;

  if (!container) return;

  // Filter
  let filtered = cache.bundles.filter(b => {
    // Basic clean filter
    if (!matchesFilterRules(b)) return false;

    // Search term matching name, id, or handle (matching extension logic)
    const matchesSearch = b.name.toLowerCase().includes(term) || String(b.id).includes(term) || (b.handle && b.handle.toLowerCase().includes(term));
    if (!matchesSearch) return false;

    // Favorites only filter
    if (favsOnly && !favorites.includes(b.id)) return false;

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
  if (favsOnly || favs.length === 0) {
    // favsOnly mode or no favorites: show everything in a single grid
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
    favHeader.innerHTML = '<h4>Pinned Favourites</h4>';
    container.appendChild(favHeader);

    const favGrid = document.createElement('div');
    favGrid.className = 'psycle-favorites-grid';
    favs.forEach(b => {
      favGrid.appendChild(createBundleCard(b, true));
    });
    container.appendChild(favGrid);

    const allHeader = document.createElement('div');
    allHeader.className = 'psycle-section-subheader';
    allHeader.style.marginTop = '24px';
    allHeader.style.cursor = 'pointer';
    allHeader.style.userSelect = 'none';
    allHeader.innerHTML = '<h4>All Credits <span class="all-credits-chevron" style="font-size:12px; margin-left:8px;">▶</span></h4>';
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
      if (chevron) chevron.textContent = isHidden ? '▼' : '▶';
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
        <div class="fav-card-handle" style="font-size: 11px; color: var(--text-tertiary); margin-top: 2px;">${b.handle} (ID: ${b.id})</div>
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
      <span class="badge-pill ${b.is_first_purchase_only ? 'badge-restricted' : 'badge-available'}">${b.is_first_purchase_only ? '1st Only' : '✔ Returning'}</span>
      <span class="badge-pill ${b.is_one_time_purchase_only ? 'badge-restricted' : 'badge-available'}">${b.is_one_time_purchase_only ? '1-Time' : '✔ Repeat'}</span>
    </div>
    <button class="psycle-btn-primary fav-card-buy-btn" style="margin-top: 12px; padding: 8px;">
      Buy on Website
    </button>
  `;

  // Star Pin button click handler
  card.querySelector('.fav-card-star-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(b.id);
  });

  // Add to cart flow: first click adds to cart, second redirects to checkout
  card.querySelector('.fav-card-buy-btn').addEventListener('click', async () => {
    const buyBtn = card.querySelector('.fav-card-buy-btn');

    if (buyBtn.dataset.cartState === 'added') {
      // Already added — redirect to checkout
      const settings = await api.getSettings();
      const instanceId = settings?.cartInstanceId;
      if (instanceId) {
        window.open(`https://psyclelondon.com/cart?instance=${instanceId}`, '_blank');
      } else {
        window.open('https://psyclelondon.com/cart', '_blank');
      }
      return;
    }

    // Add to cart
    buyBtn.disabled = true;
    buyBtn.textContent = 'Adding...';
    try {
      const result = await api.addBundleToCart(b.id);
      showToast(`Added "${b.name}" to cart!`, 'success');
      buyBtn.textContent = 'Checkout →';
      buyBtn.style.background = 'var(--success)';
      buyBtn.style.borderColor = 'var(--success)';
      buyBtn.dataset.cartState = 'added';
    } catch (err) {
      showToast(`Failed to add to cart: ${err.message}`, 'error');
      // Fallback: open product page directly
      buyBtn.textContent = 'Buy on Website';
      const handle = b.handle || '';
      window.open(`https://psyclelondon.com/products/${handle}`, '_blank');
    } finally {
      buyBtn.disabled = false;
    }
  });

  return card;
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
