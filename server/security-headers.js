// Security response headers (security audit, part 1). One middleware, mounted
// first in server.js so every response carries them; a route that needs a
// stricter value (e.g. Referrer-Policy: no-referrer on an invite link) simply
// sets its own header later and wins.
//
// CSP: script-src has NO 'unsafe-inline'. The app shell (index.html) and the
// admin SPA (admin.html) carry small inline <script> blocks; instead of
// whitelisting inline script wholesale, every text/html body sent through
// res.send() is scanned and the sha256 of each inline script is added to that
// response's script-src. That works for any route that serves HTML (templated
// or transformed), with no list of hashes to keep in step by hand.
// style-src keeps 'unsafe-inline' on purpose: the UI builds large inline
// `style="..."` attributes (AGENTS.md Known Bugs: "Inline styles everywhere")
// and index.html has an inline boot <style>. Style injection cannot run script.
const crypto = require('crypto');

const BASE_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
  // Instructor photos are proxied same-origin (/api/instructor-photo, F-15) and
  // gym logos are /gyms/*, but a few paths can still carry a provider's own
  // https image URL (MarianaTek photos live on mtproduction-files.s3.amazonaws.com;
  // normalize.js keeps the direct URL when no gym context exists). `https:` is
  // allowed for IMAGES ONLY so a missed proxy path cannot blank photos in prod;
  // script/connect/frame stay locked. data:/blob: cover inline SVG and canvases.
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'connect-src': ["'self'"],
  'media-src': ["'self'"],
  'worker-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-src': ["'none'"],
  'frame-ancestors': ["'none'"],
};

// Features the app never uses. Push, notifications, web share, clipboard and
// vibration are not restricted (they are either not policy-controlled or used).
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

function buildCsp(scriptHashes = []) {
  return Object.entries(BASE_DIRECTIVES).map(([name, values]) => {
    const all = name === 'script-src' ? [...values, ...scriptHashes.map((h) => `'sha256-${h}'`)] : values;
    return `${name} ${all.join(' ')}`;
  }).join('; ');
}

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

/** sha256 (base64) of every inline, executable <script> in an HTML document. */
function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const m of String(html).matchAll(INLINE_SCRIPT_RE)) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(text\/javascript|module|application\/javascript)$/i.test(type)) continue;
    hashes.add(crypto.createHash('sha256').update(m[2], 'utf8').digest('base64'));
  }
  return [...hashes];
}

/**
 * @param {{ hsts?: string|null, cspReportOnly?: boolean }} opts
 *   hsts: full Strict-Transport-Security value, or null to omit (non-production).
 *   cspReportOnly: send Content-Security-Policy-Report-Only instead of enforcing.
 */
function securityHeaders({ hsts = null, cspReportOnly = false } = {}) {
  const cspHeader = cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  const defaultCsp = buildCsp();
  return function securityHeadersMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader(cspHeader, defaultCsp);
    if (hsts) res.setHeader('Strict-Transport-Security', hsts);

    const send = res.send;
    res.send = function sendWithScriptHashes(body) {
      const type = String(res.getHeader('Content-Type') || '');
      if (typeof body === 'string' && /text\/html/i.test(type) && /<script/i.test(body)) {
        const hashes = inlineScriptHashes(body);
        if (hashes.length) res.setHeader(cspHeader, buildCsp(hashes));
      }
      return send.call(this, body);
    };
    next();
  };
}

module.exports = { securityHeaders, buildCsp, inlineScriptHashes, PERMISSIONS_POLICY };
