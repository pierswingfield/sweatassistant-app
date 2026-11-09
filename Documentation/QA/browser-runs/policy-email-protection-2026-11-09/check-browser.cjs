const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
let browser;
(async () => {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  let page;
  for (const p of browser.contexts()[0].pages()) {
    if (await p.evaluate(() => window.name).catch(() => null) === 'policy-email-protection') page = p;
  }
  if (!page) throw new Error('Owned Chrome tab unavailable');
  const base = process.env.BASE_URL || 'https://experiment.dibs.fit';
  const label = process.env.CAPTURE || 'before';
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.CLEAR_CACHES === '1') {
    await page.goto(base);
    await page.evaluate(async () => {
      for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      for (const key of await caches.keys()) await caches.delete(key);
      for (const db of await indexedDB.databases()) {
        await new Promise((resolve, reject) => { const req = indexedDB.deleteDatabase(db.name); req.onsuccess = resolve; req.onerror = reject; req.onblocked = () => reject(new Error('IndexedDB deletion blocked')); });
      }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  for (const doc of ['terms', 'privacy', 'terms-2026-11-09', 'privacy-2026-11-09']) {
    const response = await page.goto(`${base}/policies/${doc}.html`, { waitUntil: 'domcontentloaded' });
    const raw = await response.text();
    const cache = response.headers()['cache-control'];
    check(`${doc}: raw HTML independent of Cloudflare decoder`, !raw.includes('data-cfemail') && !raw.includes('/cdn-cgi/l/email-protection') && raw.includes('mailto:privacy@dibs.fit'), { cache });
    check(`${doc}: no-transform response`, cache?.includes('no-transform'));
    const links = await page.locator('main a[href^="mailto:"]').evaluateAll(as => as.map(a => ({ text: a.textContent, href: a.getAttribute('href') })));
    check(`${doc}: visible direct mailto contact`, links.length > 0 && links.every(a => a.text === 'privacy@dibs.fit' && a.href === 'mailto:privacy@dibs.fit'), links);
  }
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const create = page.getByText('Create an account', { exact: true });
  if (!(await create.isVisible())) {
    const login = page.getByRole('button', { name: /log in/i });
    if (await login.count()) await login.first().click();
  }
  await create.click();
  const checkbox = page.locator('input[type="checkbox"]').filter({ visible: true }).first();
  await checkbox.check();
  for (const name of ['Terms and Conditions', 'Privacy Policy']) {
    await page.getByRole('link', { name, exact: true }).filter({ visible: true }).first().click();
    const article = page.getByRole('article', { name: 'Policy document' });
    await article.getByRole('heading', { name, exact: true }).waitFor();
    const links = await article.locator('a').evaluateAll(as => as.map(a => ({ text: a.textContent, href: a.getAttribute('href') })));
    check(`${name}: embedded readable mailto, no protected links`, links.some(a => a.href === 'mailto:privacy@dibs.fit' && a.text === 'privacy@dibs.fit') && !links.some(a => a.href?.includes('/cdn-cgi/l/email-protection')), links);
    await page.waitForTimeout(450); // Let modal-nav's slide transition finish before visual evidence.
    await page.screenshot({ path: path.join(__dirname, `${label}-${name.startsWith('Terms') ? 'terms' : 'privacy'}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Close policy' }).click();
    check(`${name}: signup checkbox retained`, await checkbox.isChecked());
  }
  fs.writeFileSync(path.join(__dirname, `${label}-checks.json`), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ pass: results.filter(r => r.pass).length, total: results.length, failed: results.filter(r => !r.pass).map(r => r.name) }));
  if (process.env.CLOSE_TAB === '1') await page.close();
  await browser.close();
  process.exitCode = results.some(r => !r.pass) ? 1 : 0;
})().catch(async err => { console.error(err.message); if (browser) await browser.close(); process.exitCode = 1; });
