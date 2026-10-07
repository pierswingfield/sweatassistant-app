// C7-3 step 3: hand-rolled Prometheus text-format registry (no prom-client: we need two counters,
// one histogram and a handful of scrape-time gauges).
//
// CARDINALITY BOUNDS (aggregate only; never a user id, email, token or raw path as a label):
//   route        = express route TEMPLATE, plus the fixed values "unmatched" and "static"
//                  (<= ~150 templates)        status_class = 1xx..5xx (<= 5)
//   gym          = configured gyms (small, fixed by gyms.config.js)   platform = provider id
//   outcome      = ok | 429 | error         result = hit | stale | miss
//   histogram    = per route only (x 11 buckets), not per status
const counters = new Map(); // name -> { help, series: Map(labelKey -> { labels, value }) }
const hist = new Map();     // route -> { buckets[], sum, count }
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmtLabels = (l) => { const k = Object.keys(l); return k.length ? `{${k.map((x) => `${x}="${esc(l[x])}"`).join(',')}}` : ''; };

function inc(name, help, labels = {}, by = 1) {
  let c = counters.get(name);
  if (!c) { c = { help, series: new Map() }; counters.set(name, c); }
  const key = fmtLabels(labels);
  const s = c.series.get(key) || { labels, value: 0 };
  s.value += by; c.series.set(key, s);
}

function observeHttp(route, status, seconds) {
  inc('http_requests_total', 'HTTP requests by route template and status class.', { route, status_class: `${Math.floor(status / 100)}xx` });
  const h = hist.get(route) || { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds; h.count++; hist.set(route, h);
}

function observeProvider(gym, platform, outcome) {
  inc('provider_calls_total', 'Upstream gym provider calls by gym, platform and outcome.', { gym, platform, outcome });
}

// Express middleware: route TEMPLATE from the matched route, never the raw path.
function httpMetrics() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : ((req.originalUrl || '').startsWith('/api') ? 'unmatched' : 'static');
      observeHttp(route, res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  };
}

// extra: [{ name, help, type, samples: [[labelsObj, value], ...] }] gathered at scrape time.
function render(extra = []) {
  const out = [];
  const typeOf = new Set();
  for (const [name, c] of counters) {
    out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
    for (const s of c.series.values()) out.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
    typeOf.add(name);
  }
  if (!counters.has('provider_calls_total')) out.push('# HELP provider_calls_total Upstream gym provider calls by gym, platform and outcome.', '# TYPE provider_calls_total counter');
  out.push('# HELP http_request_duration_seconds HTTP request duration by route template.', '# TYPE http_request_duration_seconds histogram');
  for (const [route, h] of hist) {
    BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{route="${esc(route)}",le="${b}"} ${h.buckets[i]}`));
    out.push(`http_request_duration_seconds_bucket{route="${esc(route)}",le="+Inf"} ${h.count}`,
      `http_request_duration_seconds_sum{route="${esc(route)}"} ${h.sum}`,
      `http_request_duration_seconds_count{route="${esc(route)}"} ${h.count}`);
  }
  for (const m of extra) {
    out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
    for (const [labels, v] of m.samples) out.push(`${m.name}${fmtLabels(labels)} ${Number.isFinite(v) ? v : 0}`);
  }
  return out.join('\n') + '\n';
}

module.exports = { observeHttp, observeProvider, httpMetrics, render };
