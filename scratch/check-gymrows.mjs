const targetsRes = await fetch('http://127.0.0.1:9222/json/list');
const targets = await targetsRes.json();
const page = targets.find(t => t.url.includes('localhost:5173') && t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 1;
function send(m, p) {
  return new Promise((res, rej) => {
    const cur = id++;
    const h = (e) => { const d = JSON.parse(e.data); if (d.id === cur) { ws.removeEventListener('message', h); res(d.result); } };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id: cur, method: m, params: p }));
  });
}
await send('Page.navigate', { url: 'http://localhost:5173/#class-timetable' });
await new Promise(r => setTimeout(r, 1000));
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Runtime.evaluate', { expression: 'document.querySelector(".fr-trigger")?.click()' });
await new Promise(r => setTimeout(r, 400));
const res = await send('Runtime.evaluate', { expression: `(() => {
  const body = document.querySelector(".fr-body");
  const testDiv = document.createElement("div");
  testDiv.className = "fr-gymrows";
  testDiv.innerHTML = \`
    <button class="fr-gymrow on"><span class="fr-logo-plate" style="background:#0a0a0a;"><span class="ab-gym-logo-svg" style="width:70px;height:15px;display:inline-block;">AARMY</span></span></button>
    <button class="fr-gymrow on"><span class="fr-logo-plate" style="background:#70181b;"><span class="ab-gym-logo-svg" style="width:40px;height:15px;display:inline-block;">JAB</span></span></button>
    <button class="fr-gymrow on"><span class="fr-logo-plate" style="background:#111;"><span class="ab-gym-logo-svg" style="width:120px;height:15px;display:inline-block;">PSYCLE LONDON</span></span></button>
  \`;
  body.prepend(testDiv);
  const rows = Array.from(testDiv.children);
  const widths = rows.map(r => Math.round(r.getBoundingClientRect().width * 10) / 10);
  const comp = window.getComputedStyle(testDiv).gridTemplateColumns;
  testDiv.remove();
  return {
    widths,
    computedGrid: comp,
    areAllEqual: widths[0] === widths[1] && widths[1] === widths[2]
  };
})()`, returnByValue: true });
console.log(JSON.stringify(res.result.value, null, 2));
ws.close();
