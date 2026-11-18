// The ONLY reader/writer of `account_deletion_requests`: "I did not create this account" requests
// (source 'not_me'). A request is stored, then (best effort) filed as a GitHub issue through the same
// mechanism as Send Feedback. The issue is possibly public, so it carries ONLY the masked address, the
// request id and "see /admin" (never the full address, user id or IP; no IP is stored at all).
// Idempotent per account: while a request is open, asking again returns it instead of adding a row.
// "Mark done" masks the stored address: the promise to the person is that no record is kept.
const db = require('./db').db;
const feedback = require('./feedback');
const { log } = require('./logger');

const LABEL = 'user-data-urgent';

/** j***@gmail.com: first letter of the local part, the domain in full. */
function maskForIssue(addr) {
  const [local = '', domain = ''] = String(addr).split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/** Open (or return the open) request for this account. Returns { id, created }. */
function create(userId, email, source = 'not_me', now = new Date()) {
  return db.transaction(() => {
    const open = db.prepare("SELECT id FROM account_deletion_requests WHERE user_id = ? AND status = 'open'").get(userId);
    if (open) return { id: open.id, created: false };
    const info = db.prepare('INSERT INTO account_deletion_requests (user_id, email, source, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, String(email).toLowerCase(), source, 'open', now.toISOString());
    return { id: Number(info.lastInsertRowid), created: true };
  })();
}

function issuePayload(row) {
  const ref = '`#' + row.id + '`';
  return {
    title: `[User data]: deletion request #${row.id}`,
    body: ['### Request', '', 'A person says they did NOT create an account with an email address, and asked for it and any related data to be deleted.', '',
      '### Address (masked)', '', `\`${maskForIssue(row.email).replace(/`/g, '')}\``, '',
      '### Action', '', `Deletion request ${ref}: see /admin, "Account deletion requests".`].join('\n'),
    labels: [LABEL],
  };
}

/** File the issue for a stored request and record the outcome on the row. Never throws. */
async function fileIssue(id) {
  try {
    const row = db.prepare('SELECT * FROM account_deletion_requests WHERE id = ?').get(id);
    if (!row) return { skipped: true };
    const gh = await feedback.postIssue(issuePayload(row));
    if (gh.number) db.prepare('UPDATE account_deletion_requests SET github_issue_number = ?, github_issue_url = ? WHERE id = ?').run(gh.number, gh.url, id);
    else if (gh.error) {
      db.prepare('UPDATE account_deletion_requests SET github_error = ? WHERE id = ?').run(gh.error, id);
      log.warn('deletion request GitHub issue not created', { component: 'deletion-requests', requestId: id, reason: gh.error });
    }
    return gh;
  } catch (err) {
    log.warn('deletion request issue failed', { component: 'deletion-requests', requestId: id });
    return { error: 'internal' };
  }
}

/** Admin list, open first then newest. Includes the full address for open requests. */
function list({ limit = 100 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  return db.prepare(`SELECT id, user_id, email, source, status, created_at, done_at, github_issue_number, github_issue_url, github_error
    FROM account_deletion_requests ORDER BY (status = 'open') DESC, id DESC LIMIT ?`).all(lim);
}

function get(id) { return db.prepare('SELECT * FROM account_deletion_requests WHERE id = ?').get(id) || null; }

/** Mark done and mask the stored address. Returns false for an unknown id. */
function markDone(id, now = new Date()) {
  const row = get(id);
  if (!row) return false;
  if (row.status === 'done') return true;
  db.prepare("UPDATE account_deletion_requests SET status = 'done', done_at = ?, email = ? WHERE id = ?").run(now.toISOString(), maskForIssue(row.email), id);
  return true;
}

module.exports = { create, fileIssue, list, get, markDone, issuePayload, maskForIssue, LABEL };
