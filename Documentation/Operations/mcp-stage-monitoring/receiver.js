'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');

const ALERTS = new Set([
  'ProviderAdmissionPressure',
  'ScheduledProviderAdmissionDenied',
  'ProviderThrottling',
  'McpIngressAbuseOrBudgetStorageFailure',
  'McpReadFailures',
  'StageAppMetricsUnavailable',
  'StageFilesystemHeadroomLow',
  'StageOpsSyntheticAcceptance',
]);
const MAX_BODY = 32 * 1024;

function authorized(header, expected) {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const actual = Buffer.from(header.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function escapeLabel(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function createServer({ token, stateDir }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('receiver token must be at least 32 characters');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, 'aggregate-counts.json');
  let counts = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      const [alert, status] = key.split('/');
      if (ALERTS.has(alert) && ['firing', 'resolved'].includes(status) && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  function persist() {
    const tmpPath = `${statePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(counts), { mode: 0o600 });
    fs.renameSync(tmpPath, statePath);
  }

  function metrics() {
    const lines = [
      '# HELP stage_ops_alert_webhook_deliveries_total Valid private Alertmanager webhook deliveries by fixed alert and status.',
      '# TYPE stage_ops_alert_webhook_deliveries_total counter',
    ];
    for (const [key, value] of Object.entries(counts)) {
      const [alert, status] = key.split('/');
      lines.push(`stage_ops_alert_webhook_deliveries_total{alert="${escapeLabel(alert)}",status="${status}"} ${value}`);
    }
    try {
      const stat = fs.statfsSync(stateDir);
      lines.push('# HELP stage_ops_filesystem_available_bytes Available bytes on the receiver state directory filesystem.',
        '# TYPE stage_ops_filesystem_available_bytes gauge',
        `stage_ops_filesystem_available_bytes ${Number(stat.bavail) * Number(stat.bsize)}`);
    } catch {
      lines.push('# HELP stage_ops_filesystem_available_bytes Available bytes on the receiver state directory filesystem.',
        '# TYPE stage_ops_filesystem_available_bytes gauge', 'stage_ops_filesystem_available_bytes 0');
    }
    return `${lines.join('\n')}\n`;
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Connection', 'close');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('ok\n');
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(metrics());
    }
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"not found"}');
    }
    if (!authorized(req.headers.authorization, token)) {
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":"unauthorized"}');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      req.resume();
      res.writeHead(415, { 'content-type': 'application/json' });
      return res.end('{"error":"unsupported media type"}');
    }

    const chunks = [];
    let length = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY) {
        rejected = true;
        chunks.length = 0;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end('{"error":"payload too large"}');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.writableEnded) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"invalid payload"}');
      }
      if (!payload || !Array.isArray(payload.alerts) || payload.alerts.length > 20 || !['firing', 'resolved'].includes(payload.status)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"invalid payload"}');
      }
      const events = [];
      for (const alert of payload.alerts) {
        const name = alert?.labels?.alertname;
        const status = alert?.status;
        if (typeof name !== 'string' || !ALERTS.has(name) || !['firing', 'resolved'].includes(status)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"error":"unsupported alert"}');
        }
        events.push(`${name}/${status}`);
      }
      for (const key of events) counts[key] = (counts[key] || 0) + 1;
      persist();
      res.writeHead(204);
      res.end();
    });
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 20;
  return server;
}

if (require.main === module) {
  const tokenPath = process.env.RECEIVER_TOKEN_FILE || '/run/secrets/receiver_token';
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const server = createServer({ token, stateDir: process.env.RECEIVER_STATE_DIR || '/state' });
  server.listen(Number(process.env.PORT || 9091), '0.0.0.0');
}

module.exports = { createServer, MAX_BODY };
