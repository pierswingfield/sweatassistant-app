// Landing-page analytics (workstream M, step 3).
//
// The ONLY reader/writer of the `landing_events` table. First-party, cookieless:
// a visitor is sha256(day + IP + UA + server secret), so it rotates daily and the
// IP is never stored. Bot user agents are FLAGGED, never dropped (counts stay
// auditable). Public routes live under /_a/* (mounted in server.js).

const crypto = require('crypto');
const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('./db');
const config = require('./config');

const CTA_SOURCES = ['hero', 'nav', 'install', 'footer'];
const RETENTION_MONTHS = 13;
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|monitor|uptime|headless|lighthouse|curl|wget|python-requests|httpclient|go-http|node-fetch|axios|java\/|libwww|scrapy|pingdom|statuscake/i;
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function secret() {
  let s = process.env.JWT_SECRET || db.getKV('jwt_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); db.setKV('jwt_secret', s); }
  return s;
}

function clientIp(req) {
  const h = req.headers;
  const fwd = (h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0] || '').trim();
  return fwd || req.ip || '';
}

function dayOf(date) { return new Date(date).toISOString().slice(0, 10); }

function visitorHash(ip, ua, date = new Date()) {
  return crypto.createHash('sha256').update(`${dayOf(date)}|${ip}|${ua}|${secret()}`).digest('hex').slice(0, 32);
}

function isBot(ua) { return !ua || BOT_RE.test(ua); }

function deviceClass(ua) {
  if (isBot(ua)) return 'bot';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android/i.test(ua)) return 'mobile';
  return 'desktop';
}

function refHost(ref) {
  if (!ref) return null;
  try { return new URL(String(ref)).hostname.toLowerCase().slice(0, 100) || null; } catch { return null; }
}

function countryOf(req) {
  const c = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

function cleanUtm(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, 64);
  return /^[\w.\- ]+$/.test(t) ? t : null;
}

function cleanPath(v) {
  if (typeof v !== 'string' || !v.startsWith('/')) return '/';
  return v.split(/[?#]/)[0].slice(0, 120);
}

function record(req, { type, path, utm, src }) {
  const ua = String(req.headers['user-agent'] || '');
  const now = new Date();
  db.db.prepare(`INSERT INTO landing_events
    (ts, type, path, referrer_host, country, device, utm_campaign, cta_src, is_bot, visitor_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    now.toISOString(), type, path, refHost(req.headers.referer), countryOf(req),
    deviceClass(ua), utm || null, src || null, isBot(ua) ? 1 : 0, visitorHash(clientIp(req), ua, now));
}

function purgeOld(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  return db.db.prepare('DELETE FROM landing_events WHERE ts < ?').run(cutoff.toISOString()).changes;
}

function top(rows, field, n = 10) {
  const m = new Map();
  for (const r of rows) { const k = r[field]; if (k) m.set(k, (m.get(k) || 0) + 1); }
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

function stats({ days = 30, includeBots = false } = {}) {
  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 400);
  const since = new Date(Date.now() - d * 86400000).toISOString();
  const rows = db.db.prepare(
    `SELECT ts, type, referrer_host, country, device, utm_campaign, cta_src, visitor_hash
     FROM landing_events WHERE ts >= ? ${includeBots ? '' : 'AND is_bot = 0'}`).all(since);
  const daily = new Map();
  for (const r of rows) {
    const k = r.ts.slice(0, 10);
    const e = daily.get(k) || { date: k, views: 0, ctaClicks: 0, openClicks: 0, visitors: new Set() };
    if (r.type === 'pageview') { e.views++; e.visitors.add(r.visitor_hash); }
    else if (r.type === 'cta') e.ctaClicks++;
    else if (r.type === 'open') e.openClicks++;
    daily.set(k, e);
  }
  const views = rows.filter((r) => r.type === 'pageview');
  const ctas = rows.filter((r) => r.type === 'cta');
  return {
    days: d, includeBots: !!includeBots,
    totals: {
      views: views.length, ctaClicks: ctas.length, openClicks: rows.filter((r) => r.type === 'open').length,
      // Visitor hashes rotate daily, so this is the sum of daily uniques, not a cross-day unique count.
      uniqueVisitorDays: [...daily.values()].reduce((a, e) => a + e.visitors.size, 0),
      ctaClickThroughRate: views.length ? ctas.length / views.length : 0,
    },
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((e) => ({
      date: e.date, uniqueVisitors: e.visitors.size, views: e.views, ctaClicks: e.ctaClicks, openClicks: e.openClicks,
      ctaClickThroughRate: e.views ? e.ctaClicks / e.views : 0,
    })),
    topReferrers: top(views, 'referrer_host'),
    topUtmCampaigns: top(rows.filter((r) => r.type !== 'open'), 'utm_campaign'),
    ctaSources: top(ctas, 'cta_src'),
    devices: top(views, 'device'),
    countries: top(views, 'country'),
  };
}

// Public write endpoint: IP-keyed, production-only (or forced in tests), like the other limiters.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
  message: 'Too many requests.',
  skip: () => process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_TEST_FORCE !== '1',
});

const router = express.Router();
router.use(limiter);

router.get('/pv', (req, res) => {
  try { record(req, { type: 'pageview', path: cleanPath(req.query.p), utm: cleanUtm(req.query.utm_campaign) }); }
  catch (e) { console.warn('[Landing] record failed:', e.message); }
  res.set({ 'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'image/gif', 'Content-Length': GIF.length });
  res.end(GIF);
});

router.get('/go', (req, res) => {
  const src = typeof req.query.src === 'string' ? req.query.src : '';
  const isOpen = src === 'open';
  // Unknown src is recorded as nothing but the redirect still goes to the fixed target.
  if (isOpen || CTA_SOURCES.includes(src)) {
    try {
      record(req, { type: isOpen ? 'open' : 'cta', path: '/', utm: cleanUtm(req.query.utm_campaign), src: isOpen ? null : src });
    } catch (e) { console.warn('[Landing] record failed:', e.message); }
  }
  res.set('Cache-Control', 'no-store');
  res.redirect(302, config.landingCtaTarget);
});

module.exports = { router, record, stats, purgeOld, visitorHash, deviceClass, isBot, CTA_SOURCES };
