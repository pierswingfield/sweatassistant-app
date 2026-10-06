const targetsRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await targetsRes.json();
let page = targets.find(t => t.url.includes('sweat-dev.wingfield.tech') && t.type === 'page');

if (!page) {
  console.log('No sweat-dev tab found');
  process.exit(1);
}

console.log('Testing live sweat-dev tab:', page.title, page.url, page.id);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);

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

// Emulate iPhone 14
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
});

// Force reload ignoring cache so new service worker and assets take effect
console.log('Reloading sweat-dev ignoring cache...');
await send('Page.reload', { ignoreCache: true });
await new Promise(r => setTimeout(r, 2500));

// Navigate to #settings
await send('Page.navigate', { url: 'https://sweat-dev.wingfield.tech/#settings' });
await new Promise(r => setTimeout(r, 1500));

// Activate "Your Gyms"
await evalCode(`(() => {
  const layout = document.getElementById('psycle-settings-layout-wrapper');
  layout?.__activateSettingsSection?.('gyms');
})()`);
await new Promise(r => setTimeout(r, 800));

const rowsInfo = await evalCode(`(() => {
  const rows = Array.from(document.querySelectorAll('.psycle-gym-conn-row')).map(row => {
    const gymKey = row.getAttribute('data-gym-key');
    const nameEl = row.querySelector('.psycle-gym-conn-name');
    const strong = nameEl?.querySelector('strong');
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
      emailActionsSameRow: Math.abs((smallRect?.top || 0) - (actionsRect?.top || 0)) < 15,
      healthBelowEmail: (healthRect?.top || 0) > (smallRect?.top || 0),
      smallTop: smallRect?.top,
      actionsTop: actionsRect?.top,
      healthTop: healthRect?.top,
      whenTop: whenRect?.top,
    };
  });
  return rows;
})()`);
console.log('Sweat-dev Your Gyms rows layout:', JSON.stringify(rowsInfo, null, 2));

// Test drill-down tap on JAB or first row
const tapDrill = await evalCode(`(() => {
  const row = Array.from(document.querySelectorAll('.psycle-gym-conn-row')).find(r => r.getAttribute('data-gym-key') === 'jab-boxing') || document.querySelector('.psycle-gym-conn-row');
  if (!row) return { error: 'no row' };
  const targetGymId = row.getAttribute('data-gym-key');
  row.click();
  const activePane = document.querySelector('.psycle-settings-section-pane.active');
  return {
    targetGymId,
    activePaneId: activePane?.id,
    drilledDown: activePane?.id === ('psycle-settings-pane-gym-' + targetGymId)
  };
})()`);
console.log('Sweat-dev drill-down tap result:', JSON.stringify(tapDrill, null, 2));
await new Promise(r => setTimeout(r, 500));

// Test gym-specific pane layout
const gymPane = await evalCode(`(() => {
  const activePane = document.querySelector('.psycle-settings-section-pane.active');
  const heading = activePane?.querySelector('.psycle-gym-settings-heading');
  const h3 = heading?.querySelector('h3');
  const eyebrow = heading?.querySelector('.psycle-eyebrow');
  const brand = heading?.querySelector('.psycle-gym-settings-brand');
  const badge = heading?.querySelector('.psycle-badge');
  const brandRect = brand?.getBoundingClientRect();
  const badgeRect = badge?.getBoundingClientRect();

  const connCard = activePane?.querySelector('.psycle-settings-card');
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
    email: emailEl?.textContent
  };
})()`);
console.log('Sweat-dev gym pane layout:', JSON.stringify(gymPane, null, 2));

// Test back button
const backRes = await evalCode(`(() => {
  const backBtn = document.getElementById('psycle-settings-back-btn');
  backBtn?.click();
  const activePane = document.querySelector('.psycle-settings-section-pane.active');
  return {
    activePaneId: activePane?.id,
    returnedToGyms: activePane?.id === 'psycle-settings-pane-gyms'
  };
})()`);
console.log('Sweat-dev back button result:', JSON.stringify(backRes, null, 2));

ws.close();
process.exit(0);
