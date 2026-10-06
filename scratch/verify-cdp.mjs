// Scratch CDP verification script
const targetsRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await targetsRes.json();
let page = targets.find(t => t.url.includes('localhost:5173') && t.type === 'page');

if (!page) {
  // Create or pick any page
  page = targets.find(t => t.type === 'page');
}

console.log('Connecting to target:', page.title, page.url, page.id);
const ws = new WebSocket(page.webSocketDebuggerUrl);

await new Promise((resolve) => ws.onopen = resolve);

let idCounter = 1;
function send(method, params = {}) {
  const id = idCounter++;
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(msg.error);
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalCode(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result.value;
}

// 1. Navigate to timetable
console.log('Navigating to timetable...');
await send('Page.navigate', { url: 'http://localhost:5173/#class-timetable' });

// Emulate mobile device: iPhone 14 (390 x 844)
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});

// Wait up to 5s for auth and timetable
for (let i = 0; i < 20; i++) {
  const ready = await evalCode(`Boolean(document.getElementById('sweat-filter-rail'))`);
  if (ready) break;
  await new Promise(r => setTimeout(r, 250));
}

let ready = await evalCode(`Boolean(document.getElementById('sweat-filter-rail'))`);
console.log('Filter rail ready:', ready);

// If not logged in, check if login modal is showing
const loginModal = await evalCode(`Boolean(document.getElementById('psycle-login-modal')?.classList.contains('show'))`);
console.log('Login modal showing:', loginModal);
if (loginModal) {
  await evalCode(`(() => {
    const email = document.getElementById('psycle-login-email');
    const pass = document.getElementById('psycle-login-password');
    if (email) email.value = 'dev@psycle.com';
    if (pass) pass.value = 'password';
    document.getElementById('psycle-login-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise(r => setTimeout(r, 2000));
}

for (let i = 0; i < 20; i++) {
  const r = await evalCode(`Boolean(document.getElementById('sweat-filter-rail'))`);
  if (r) break;
  await new Promise(r => setTimeout(r, 250));
}

ready = await evalCode(`Boolean(document.getElementById('sweat-filter-rail'))`);
console.log('Filter rail ready after login:', ready);

// Open the filter drawer
await evalCode(`document.querySelector('.fr-trigger')?.click()`);
await new Promise(r => setTimeout(r, 500));

// Check filter sheet and 3-column widths
const sheetInfo = await evalCode(`(() => {
  const sheet = document.querySelector('.fr-sheet');
  const gymrows = document.querySelector('.fr-gymrows');
  const gyms = Array.from(document.querySelectorAll('.fr-gymrow')).map(el => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
  });
  const badge = document.querySelector('.fr-badge')?.textContent;
  return { sheetExists: !!sheet, gyms, badge };
})()`);
console.log('Sheet info:', JSON.stringify(sheetInfo, null, 2));

// Test filter tap latency
const tapResult = await evalCode(`(async () => {
  const opt = document.querySelector('.fr-opt[data-fr-toggle="locations"]');
  if (!opt) return { error: 'no location option found' };
  const beforeBadge = document.querySelector('.fr-badge')?.textContent;
  const t0 = performance.now();
  opt.click();
  const tClick = performance.now() - t0;
  const isNowOn = opt.classList.contains('on');
  const afterBadge = document.querySelector('.fr-badge')?.textContent;
  
  // Now deselect
  const t1 = performance.now();
  opt.click();
  const tDeselect = performance.now() - t1;
  const isNowOff = !opt.classList.contains('on');
  const deselectBadge = document.querySelector('.fr-badge')?.textContent;

  return {
    tClickMs: Math.round(tClick * 100) / 100,
    isNowOn,
    beforeBadge,
    afterBadge,
    tDeselectMs: Math.round(tDeselect * 100) / 100,
    isNowOff,
    deselectBadge,
  };
})()`);
console.log('Filter tap latency test:', JSON.stringify(tapResult, null, 2));

// Close filter sheet
await evalCode(`document.querySelector('.fr-close')?.click()`);
await new Promise(r => setTimeout(r, 350));

// 2. Navigate to Settings
console.log('Navigating to settings...');
await send('Page.navigate', { url: 'http://localhost:5173/#settings' });
await new Promise(r => setTimeout(r, 1500));

// Activate "Your Gyms" section
await evalCode(`(() => {
  const layout = document.getElementById('psycle-settings-layout-wrapper');
  layout?.__activateSettingsSection?.('gyms');
})()`);
await new Promise(r => setTimeout(r, 400));

// Check Your Gyms rows layout on mobile
const gymsLayoutInfo = await evalCode(`(() => {
  const rows = Array.from(document.querySelectorAll('.psycle-gym-conn-row')).map(row => {
    const gymKey = row.getAttribute('data-gym-key');
    const nameEl = row.querySelector('.psycle-gym-conn-name');
    const strong = nameEl?.querySelector('strong'); // should be null
    const small = nameEl?.querySelector('small');
    const actions = row.querySelector('.psycle-gym-conn-actions');
    const health = row.querySelector('.psycle-gym-conn-health');
    const when = row.querySelector('.psycle-gym-conn-when');
    
    const smallRect = small?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    const healthRect = health?.getBoundingClientRect();
    const whenRect = when?.getBoundingClientRect();

    return {
      gymKey,
      hasStrongName: !!strong,
      email: small?.textContent,
      // Check if email and actions are vertically aligned on the same row:
      emailActionsSameRow: Math.abs((smallRect?.top || 0) - (actionsRect?.top || 0)) < 15,
      // Check if health and when are below row 2:
      healthBelowEmail: (healthRect?.top || 0) > (smallRect?.top || 0),
      smallTop: smallRect?.top,
      actionsTop: actionsRect?.top,
      healthTop: healthRect?.top,
      whenTop: whenRect?.top,
    };
  });
  return rows;
})()`);
console.log('Your Gyms layout info:', JSON.stringify(gymsLayoutInfo, null, 2));

// Test tapping a gym row to drill down
const drilldownResult = await evalCode(`(() => {
  const firstRow = document.querySelector('.psycle-gym-conn-row');
  if (!firstRow) return { error: 'no gym row found' };
  const targetGymId = firstRow.getAttribute('data-gym-key');
  firstRow.click();
  
  const activePane = document.querySelector('.psycle-settings-section-pane.active');
  return {
    targetGymId,
    activePaneId: activePane?.id,
    drilledDown: activePane?.id === ('psycle-settings-pane-gym-' + targetGymId),
  };
})()`);
console.log('Drill-down tap test:', JSON.stringify(drilldownResult, null, 2));

await new Promise(r => setTimeout(r, 400));

// Check gym-specific pane layout
const gymPaneInfo = await evalCode(`(() => {
  const activePane = document.querySelector('.psycle-settings-section-pane.active');
  if (!activePane) return { error: 'no active gym pane' };

  const heading = activePane.querySelector('.psycle-gym-settings-heading');
  const h3 = heading?.querySelector('h3'); // should be null
  const eyebrow = heading?.querySelector('.psycle-eyebrow'); // should be null
  const brand = heading?.querySelector('.psycle-gym-settings-brand');
  const badge = heading?.querySelector('.psycle-badge');

  const brandRect = brand?.getBoundingClientRect();
  const badgeRect = badge?.getBoundingClientRect();

  // Connection card
  const connCard = activePane.querySelector('.psycle-settings-card');
  const inlineRow = connCard?.querySelector('.psycle-gym-conn-inline-row');
  const emailEl = inlineRow?.querySelector('.psycle-card-desc');
  const btnRow = inlineRow?.querySelector('.psycle-settings-btn-row');

  const emailRect = emailEl?.getBoundingClientRect();
  const btnRowRect = btnRow?.getBoundingClientRect();

  return {
    hasH3GymName: !!h3,
    hasEyebrow: !!eyebrow,
    brandAndBadgeAligned: Math.abs((brandRect?.top || 0) - (badgeRect?.top || 0)) < 15,
    hasInlineConnRow: !!inlineRow,
    emailAndButtonsSameRow: Math.abs((emailRect?.top || 0) - (btnRowRect?.top || 0)) < 15,
    emailText: emailEl?.textContent,
  };
})()`);
console.log('Gym specific pane layout info:', JSON.stringify(gymPaneInfo, null, 2));

// Test back button returning to Your Gyms
const backResult = await evalCode(`(() => {
  const backBtn = document.getElementById('psycle-settings-back-btn');
  backBtn?.click();
  const activePane = document.querySelector('.psycle-settings-section-pane.active');
  return {
    activePaneId: activePane?.id,
    returnedToGyms: activePane?.id === 'psycle-settings-pane-gyms',
  };
})()`);
console.log('Back button test:', JSON.stringify(backResult, null, 2));

ws.close();
process.exit(0);
