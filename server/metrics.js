// C7-3 step 3: hand-rolled Prometheus text-format registry (no prom-client: we need two counters,
// one histogram and a handful of scrape-time gauges).
//
// CARDINALITY BOUNDS (never a user id, email, token or raw path as a label):
//   route        = express route TEMPLATE, plus the fixed values "unmatched" and "static"
//                  (<= ~150 templates)        status_class = 1xx..5xx (<= 5)
//   gym          = configured gyms (small, fixed by gyms.config.js)   platform = provider id
//   outcome      = ok | 429 | error         result = hit | stale | miss
//   histogram    = per route only (x 11 buckets), not per status
//   MCP client   = at most ten operator-registered IDs plus fixed other per process
//   MCP tool     = fixed catalog names plus fixed unknown; gym = config or fixed none
const counters = new Map(); // name -> { help, series: Map(labelKey -> { labels, value }) }
const hist = new Map();     // route -> { buckets[], sum, count }
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
// Client IDs come only from operator registration, with a lifetime process cap.
// Never allocate a new series label from a token, request argument or account.
const mcpClients = new Set();
const mcpTools = new Set(['list_connected_gyms', 'search_classes', 'get_class_details', 'get_my_bookings', 'get_credits', 'get_automation', 'prepare_booking', 'prepare_booking_edit', 'prepare_booking_cancel', 'execute_booking_action', 'get_booking_action']);
function configureMcpClients(ids) {
  for (const id of ids) if (mcpClients.size < 10 && typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id)) mcpClients.add(id);
}
function mcpLabels(clientId, tool, gymId) {
  return { client: mcpClients.has(clientId) ? clientId : 'other', tool: mcpTools.has(tool) ? tool : 'unknown',
    gym: require('./gyms.config').getGymConfig(gymId)?.id || 'none' };
}
function observeMcpWork(kind, result, by = 1) {
  const state = require('./mcp/context').current();
  if (!state) return;
  inc(`mcp_client_${kind}_total`, `MCP client ${kind} by bounded registration, tool, gym and result.`,
    { ...mcpLabels(state.actor.clientId, state.tool, state.gymId), result }, by);
}

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

function observeMcpTool(tool, result, milliseconds, clientId, gymId) {
  inc('mcp_tools_total', 'MCP tool outcomes by fixed tool and result.', { tool, result });
  inc('mcp_tool_duration_milliseconds_total', 'Total MCP tool execution duration.', { tool }, milliseconds);
  const labels = mcpLabels(clientId, tool, gymId);
  inc('mcp_client_tools_total', 'MCP client tool outcomes.', { ...labels, result });
  inc('mcp_client_tool_duration_milliseconds_total', 'Total MCP client tool execution duration.', labels, milliseconds);
}
function observeMcpIngress(result) {
  inc('mcp_ingress_rejections_total', 'MCP ingress refusals by fixed result.', { result });
}
// MCP/OAuth routers are intentionally mounted ahead of the general HTTP
// metrics/logger middleware. Count only these two sensitive endpoints here,
// using fixed labels so early authentication responses remain observable
// without recording paths, query strings, headers, or request bodies.
function observeMcpHttp(route, method, statusCode) {
  const fixedRoute = route === 'mcp' || route === 'oauth_token' ? route : 'other';
  const fixedMethod = ['GET', 'POST', 'OPTIONS'].includes(method) ? method.toLowerCase() : 'other';
  const fixedStatus = statusCode === 401 ? '401' : statusCode === 403 ? '403' :
    statusCode >= 200 && statusCode < 300 ? '2xx' :
      statusCode >= 400 && statusCode < 500 ? '4xx' :
        statusCode >= 500 && statusCode < 600 ? '5xx' : 'other';
  inc('mcp_http_requests_total', 'MCP and OAuth endpoint requests by fixed route, method and status.',
    { route: fixedRoute, method: fixedMethod, status: fixedStatus });
}
function observeCache(result) {
  inc('schedule_cache_total', 'Shared schedule cache outcomes.', { result });
  observeMcpWork('cache', result);
}
function observeAdmission(lane, result) {
  inc('provider_admission_total', 'Provider admission outcomes by fixed actor lane.', { lane, result });
  observeMcpWork('admission', result);
}
module.exports = { configureMcpClients, observeMcpWork, observeMcpTool, observeMcpIngress, observeMcpHttp, observeCache, observeAdmission, observeHttp, observeProvider, httpMetrics, render };
