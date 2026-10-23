// M step 3 — landing analytics: recording, daily hash rotation, CTA redirect, rate limit, admin stats.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'scratch-admin-pw';
process.env.JWT_SECRET = 'scratch-jwt';
process.env.RATE_LIMIT_TEST_FORCE = '1';

const assert = require('assert');
const http = require('http');
const express = require('express');
const db = require('./db');
const config = require('./config');
const landing = require('./landing-events');
const adminRouter = require('./admin');

const app = express();
app.use('/_a', landing.router);
app.use('/api/admin', adminRouter);

const UA_M = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const UA_D = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port, path, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const rows = () => db.db.prepare('SELECT * FROM landing_events ORDER BY id').all();

(async () => {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    // --- pageview ---
    const pv = await get(port, '/_a/pv?p=/&utm_campaign=autumn', {
      'user-agent': UA_M, referer: 'https://www.google.com/search?q=secret', 'cf-ipcountry': 'GB', 'x-real-ip': '203.0.113.9' });
    assert.strictEqual(pv.status, 200);
    assert.strictEqual(pv.headers['content-type'], 'image/gif');
    assert.ok(/no-store/.test(pv.headers['cache-control']));
    assert.ok(!pv.headers['set-cookie'], 'no cookies');
    assert.strictEqual(pv.body.slice(0, 3).toString(), 'GIF');
    let r = rows()[0];
    assert.strictEqual(r.type, 'pageview');
    assert.strictEqual(r.referrer_host, 'www.google.com', 'host only, no path/query');
    assert.strictEqual(r.country, 'GB');
    assert.strictEqual(r.device, 'mobile');
    assert.strictEqual(r.utm_campaign, 'autumn');
    assert.strictEqual(r.is_bot, 0);
    assert.ok(!JSON.stringify(r).includes('203.0.113.9'), 'IP never stored');

    // bots are flagged, not dropped
    await get(port, '/_a/pv', { 'user-agent': 'Googlebot/2.1' });
    r = rows()[1];
    assert.strictEqual(r.is_bot, 1);
    assert.strictEqual(r.device, 'bot');

    // --- visitor hash rotation ---
    const d1 = new Date('2026-10-01T10:00:00Z'), d2 = new Date('2026-10-02T10:00:00Z');
    const h1 = landing.visitorHash('1.2.3.4', UA_D, d1);
    assert.strictEqual(h1, landing.visitorHash('1.2.3.4', UA_D, new Date('2026-10-01T23:59:00Z')), 'stable within a day');
    assert.notStrictEqual(h1, landing.visitorHash('1.2.3.4', UA_D, d2), 'rotates across days');
    assert.notStrictEqual(h1, landing.visitorHash('1.2.3.5', UA_D, d1));
    assert.ok(!h1.includes('1.2.3.4'));

    // --- CTA redirect ---
    for (const src of ['hero', 'nav', 'install', 'footer']) {
      const g = await get(port, `/_a/go?src=${src}&utm_campaign=autumn`, { 'user-agent': UA_D });
      assert.strictEqual(g.status, 302);
      assert.strictEqual(g.headers.location, config.landingCtaTarget);
    }
    const open = await get(port, '/_a/go?src=open', { 'user-agent': UA_D });
    assert.strictEqual(open.headers.location, config.landingCtaTarget);
    const types = rows().map((x) => `${x.type}:${x.cta_src}`);
    assert.ok(types.includes('cta:hero') && types.includes('cta:footer') && types.includes('open:null'));

    const before = rows().length;
    for (const bad of ['src=evil', 'src=https://evil.example', 'src=hero&next=https://evil.example', 'url=https://evil.example', 'src=%2F%2Fevil.example']) {
      const g = await get(port, `/_a/go?${bad}`, { 'user-agent': UA_D });
      assert.strictEqual(g.status, 302);
      assert.strictEqual(g.headers.location, config.landingCtaTarget, `open redirect via ${bad}`);
    }
    assert.strictEqual(rows().length, before + 1, 'only the valid src=hero row recorded; bad src rejected');

    // --- purge (13 months) ---
    db.db.prepare(`INSERT INTO landing_events (ts,type,device,visitor_hash) VALUES (?,?,?,?)`)
      .run(new Date(Date.now() - 400 * 86400000).toISOString(), 'pageview', 'desktop', 'old');
    assert.strictEqual(landing.purgeOld(), 1);
    assert.strictEqual(db.db.prepare("SELECT COUNT(*) c FROM landing_events WHERE visitor_hash='old'").get().c, 0);

    // --- admin stats ---
    assert.strictEqual((await get(port, '/api/admin/landing-stats')).status, 401);
    assert.strictEqual((await get(port, '/api/admin/landing-stats', { authorization: 'Bearer junk' })).status, 403);
    const jwt = require('jsonwebtoken');
    const auth = { authorization: `Bearer ${jwt.sign({ admin: true }, process.env.JWT_SECRET)}` };
    const s = await get(port, '/api/admin/landing-stats?days=7', auth);
    assert.strictEqual(s.status, 200);
    const j = JSON.parse(s.body);
    for (const k of ['totals', 'daily', 'topReferrers', 'topUtmCampaigns', 'devices', 'countries', 'ctaSources']) assert.ok(k in j, k);
    assert.strictEqual(j.totals.views, 1, 'bot excluded by default');
    assert.strictEqual(j.totals.ctaClicks, 5);
    assert.strictEqual(j.totals.ctaClickThroughRate, 5);
    assert.strictEqual(j.topReferrers[0].name, 'www.google.com');
    assert.strictEqual(j.daily[0].uniqueVisitors, 1);
    const withBots = JSON.parse((await get(port, '/api/admin/landing-stats?includeBots=1', auth)).body);
    assert.strictEqual(withBots.totals.views, 2);

    // --- rate limit ---
    let limited = 0;
    for (let i = 0; i < 130; i++) {
      const g = await get(port, '/_a/pv', { 'user-agent': UA_D, 'x-real-ip': '198.51.100.7' });
      if (g.status === 429) limited++;
    }
    assert.ok(limited > 0, 'rate limiter engaged');
    assert.strictEqual((await get(port, '/_a/pv', { 'x-real-ip': '198.51.100.8' })).status, 200, 'other IPs unaffected');

    console.log('landing-events: all assertions passed');
  } finally {
    server.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
