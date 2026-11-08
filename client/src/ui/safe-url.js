/**
 * Provider-supplied URLs (instructor socials, photos) are untrusted. Every one
 * that reaches an `href` or `src` goes through here first.
 *
 * - `safeHttpsUrl(raw, hosts)` → the normalised URL string only when it parses
 *   as `https:` and (if `hosts` is given) its host is one of them or a
 *   subdomain of one. Anything else (`javascript:`, `data:`, `http:`, junk)
 *   is '' so the caller drops the link.
 * - `safeImageUrl(raw)` → a same-origin path (`/api/instructor-photo/…`,
 *   `/gyms/…`) or an `https:` URL; '' otherwise.
 *
 * The result is still interpolated into markup, so callers escape it as an
 * attribute value as well (`escapeHtml(safeHttpsUrl(...))`).
 */

export const INSTAGRAM_HOSTS = ['instagram.com'];
export const SPOTIFY_HOSTS = ['spotify.com'];

function hostAllowed(host, hosts) {
  if (!hosts || !hosts.length) return true;
  const h = String(host || '').toLowerCase();
  return hosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

export function safeHttpsUrl(raw, hosts = null) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  let url;
  try { url = new URL(s); } catch { return ''; }
  if (url.protocol !== 'https:') return '';
  if (url.username || url.password) return '';
  if (!hostAllowed(url.hostname, hosts)) return '';
  return url.href;
}

export function safeImageUrl(raw) {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  // Same-origin absolute path; `//host` (protocol-relative) and `/\host` are not.
  if (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\')) return s;
  return safeHttpsUrl(s);
}
