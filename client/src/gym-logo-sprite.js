// Gym wordmarks as an inline <symbol> sprite (no per-use network, decode or image cache).
//
// Why: a logo <img> is re-created by every card/sheet re-render, and on iOS each new <img> goes
// through an ASYNC decode, which shows as a flicker even when the bytes are cached. An inline
// <svg><use href="#symbol"/></svg> paints in the same frame as the DOM insertion. The sprite is built
// at runtime from the data-driven wordmark `src` paths in the gym presentation (F-7), so no gym is
// named here; only `.svg` sources qualify, anything else keeps using <img>.
const NS = 'http://www.w3.org/2000/svg';
const symbols = new Map(); // src -> { id, viewBox }
const inflight = new Map();
let sprite = null;

const isSvg = (src) => /\.svg(\?|$)/i.test(src || '');
const slug = (src) => 'gl-' + String(src).replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');

function ensureSprite() {
  if (sprite || typeof document === 'undefined') return sprite;
  sprite = document.createElementNS(NS, 'svg');
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('focusable', 'false');
  sprite.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.insertBefore(sprite, document.body.firstChild);
  return sprite;
}

async function register(src) {
  if (symbols.has(src) || inflight.has(src) || !isSvg(src)) return;
  const job = fetch(src).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status)))).then((text) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return;
    let vb = root.getAttribute('viewBox');
    if (!vb) { const w = parseFloat(root.getAttribute('width')), h = parseFloat(root.getAttribute('height')); if (w && h) vb = `0 0 ${w} ${h}`; }
    if (!vb) return;
    const sym = document.createElementNS(NS, 'symbol');
    const id = slug(src);
    sym.setAttribute('id', id);
    sym.setAttribute('viewBox', vb);
    [...root.childNodes].forEach((n) => sym.appendChild(document.importNode(n, true)));
    ensureSprite()?.appendChild(sym);
    symbols.set(src, { id, viewBox: vb });
  }).catch(() => {}).finally(() => inflight.delete(src));
  inflight.set(src, job);
  return job;
}

/** Fetch + register every .svg wordmark in the catalogue; fires `gym-logos-ready` when new symbols land. */
export function loadWordmarkSprites(presentations) {
  const srcs = new Set();
  for (const p of presentations.values ? presentations.values() : presentations) {
    for (const k of ['full', 'compact', 'mark']) { const s = p?.wordmark?.[k]?.src; if (s) srcs.add(s); }
  }
  const before = symbols.size;
  Promise.all([...srcs].map(register)).then(() => {
    if (symbols.size !== before && typeof document !== 'undefined') document.dispatchEvent(new Event('gym-logos-ready'));
  });
}

/** `{ id, viewBox }` when `src` is already in the sprite, else null (caller falls back to <img>). */
export function spriteRefFor(src) { return symbols.get(src) || null; }
