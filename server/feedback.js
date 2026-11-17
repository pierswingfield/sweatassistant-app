// Send Feedback (Settings > Send Feedback).
//
// The ONLY reader/writer of the `feedback` table. Every submission is stored first;
// then, when GITHUB_FEEDBACK_TOKEN and GITHUB_FEEDBACK_REPO are both set, it is also
// filed as a GitHub issue. The repo may be public, so the issue NEVER carries the
// follow-up email, the account email or the user id: it says only whether a follow-up
// email was given and points at the admin feedback id. A GitHub failure (or timeout)
// never fails the submission; the row keeps the error for the admin list.
// Never log the token or the email.

const express = require('express');
const db = require('./db');
const { authenticateToken } = require('./auth');
const { log } = require('./logger');

const TYPES = {
  bug: { label: 'Bug report', ghLabel: 'bug' },
  gym: { label: 'New gym request', ghLabel: 'gym-request' },
  feature: { label: 'Feature request', ghLabel: 'enhancement' },
  general: { label: 'General enquiry', ghLabel: 'question' },
};
const LIMITS = { title: 120, message: 5000, email: 254, build: 64 };
const RATE = { max: 5, windowMs: 60 * 60 * 1000 };
const GITHUB_TIMEOUT_MS = 8000;
// Pragmatic, not RFC 5322: one @, no spaces, a dot in the domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(v) { return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : ''; }

/** Validate a submission body. Returns { value } or { errors: { field: message } }. */
function validate(body = {}) {
  const errors = {};
  const type = typeof body.type === 'string' ? body.type : '';
  if (!TYPES[type]) errors.type = 'Choose a type.';
  const title = clean(body.title).replace(/\s+/g, ' ');
  if (!title) errors.title = 'Add a short title.';
  else if (title.length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`;
  const message = clean(body.message);
  if (!message) errors.message = 'Tell us a little more.';
  else if (message.length > LIMITS.message) errors.message = `Keep the message under ${LIMITS.message} characters.`;
  const email = clean(body.email).toLowerCase();
  if (email && (email.length > LIMITS.email || !EMAIL_RE.test(email))) errors.email = 'Enter a valid email address, or leave it blank.';
  const build = clean(body.build).slice(0, LIMITS.build) || null;
  if (Object.keys(errors).length) return { errors };
  return { value: { type, title, message, email: email || null, build } };
}

/** A coarse, non-identifying platform summary from a user agent. */
function platformOf(ua = '') {
  const s = String(ua);
  const os = /iPhone|iPad|iPod/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Other';
  const browser = /Edg\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox'
    : /Safari\//.test(s) ? 'Safari' : 'Other';
  return `${os} · ${browser}`;
}

function appVersion() {
  return require('./package.json').version;
}

function countRecent(userId, now = Date.now()) {
  return db.db.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND created_at > ?')
    .get(userId, new Date(now - RATE.windowMs).toISOString()).n;
}

function insert(userId, v, ctx) {
  const info = db.db.prepare(`INSERT INTO feedback
    (user_id, type, title, message, email, app_version, client_build, platform, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, v.type, v.title, v.message, v.email, ctx.appVersion, v.build, ctx.platform, ctx.userAgent, ctx.createdAt);
  return Number(info.lastInsertRowid);
}

/** The issue payload. Pure, so the suite can assert no personal data reaches it. */
function issuePayload(row) {
  const t = TYPES[row.type];
  const body = [
    row.message,
    '',
    '---',
    `- Type: ${t.label}`,
    `- App version: ${row.app_version || 'unknown'}${row.client_build ? ` (build ${row.client_build})` : ''}`,
    `- Platform: ${row.platform || 'unknown'}`,
    `- Follow-up email provided: ${row.email ? 'yes' : 'no'} (see admin feedback #${row.id})`,
    `- Feedback id: ${row.id}`,
  ].join('\n');
  return { title: `[${t.label}] ${row.title}`, body, labels: [t.ghLabel, 'feedback'] };
}

function githubConfig() {
  const token = process.env.GITHUB_FEEDBACK_TOKEN;
  const repo = process.env.GITHUB_FEEDBACK_REPO;
  if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { token, repo };
}

// Swappable in tests.
let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

/** File the row as a GitHub issue. Resolves { number, url } or { error }; never throws. */
async function createIssue(row) {
  const cfg = githubConfig();
  if (!cfg) return { skipped: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GITHUB_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${cfg.repo}/issues`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json',
        'user-agent': 'dibs-feedback',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(issuePayload(row)),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `GitHub ${res.status}` };
    const data = await res.json();
    if (!data || !Number.isInteger(data.number)) return { error: 'GitHub response had no issue number' };
    return { number: data.number, url: typeof data.html_url === 'string' ? data.html_url : null };
  } catch (err) {
    return { error: err && err.name === 'AbortError' ? 'GitHub timeout' : 'GitHub request failed' };
  } finally {
    clearTimeout(timer);
  }
}

function getRow(id) { return db.db.prepare('SELECT * FROM feedback WHERE id = ?').get(id); }

/** Admin list, newest first. Includes the follow-up email (admin only). */
function list({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = db.db.prepare(`SELECT f.id, f.user_id, u.email AS account_email, f.type, f.title, f.message, f.email,
      f.app_version, f.client_build, f.platform, f.created_at, f.github_issue_number, f.github_issue_url, f.github_error
    FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(lim, off);
  const total = db.db.prepare('SELECT COUNT(*) AS n FROM feedback').get().n;
  return { total, feedback: rows.map((r) => ({ ...r, typeLabel: TYPES[r.type]?.label || r.type })) };
}

async function submit(userId, body, { userAgent = '', now = Date.now() } = {}) {
  const { value, errors } = validate(body);
  if (errors) return { status: 400, body: { code: 'INVALID_FEEDBACK', message: 'Please check the highlighted fields.', errors } };
  if (countRecent(userId, now) >= RATE.max) {
    return { status: 429, body: { code: 'FEEDBACK_RATE_LIMITED', message: 'Thanks, we have plenty from you for now. Please try again in an hour.' } };
  }
  const ua = String(userAgent || '').slice(0, 300);
  const id = insert(userId, value, { appVersion: appVersion(), platform: platformOf(ua), userAgent: ua, createdAt: new Date(now).toISOString() });
  const gh = await createIssue(getRow(id));
  if (gh.number) {
    db.db.prepare('UPDATE feedback SET github_issue_number = ?, github_issue_url = ? WHERE id = ?').run(gh.number, gh.url, id);
  } else if (gh.error) {
    db.db.prepare('UPDATE feedback SET github_error = ? WHERE id = ?').run(gh.error, id);
    log.warn('feedback GitHub issue not created', { component: 'feedback', feedbackId: id, reason: gh.error });
  }
  return { status: 201, body: { ok: true, id } };
}

const router = express.Router();
router.post('/feedback', authenticateToken, async (req, res) => {
  try {
    const out = await submit(req.userId, req.body || {}, { userAgent: req.headers['user-agent'] });
    res.status(out.status).json(out.body);
  } catch (err) {
    log.error('feedback submit failed', { component: 'feedback', err });
    res.status(500).json({ message: 'Could not send your feedback. Please try again.' });
  }
});

module.exports = { router, validate, submit, list, issuePayload, createIssue, platformOf, setFetchForTests, TYPES, LIMITS, RATE };
