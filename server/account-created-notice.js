// Core of the one-off "your account has been created" service notice (step 4). The CLI is
// server/scripts/send-account-created-notice.js; this module holds the logic so a suite can
// drive it with an injected clock/sleep and the email.js test transport.
//
// Idempotency: the existing `sent_notifications` ledger (UNIQUE(user_id, dedupe_key)) with
// key NOTICE_KEY, written only AFTER a confirmed send. A re-run selects only accounts with no
// ledger row, so nobody is mailed twice; the Resend Idempotency-Key is a second guard for a
// crash between the send and the ledger write inside Resend's 24 h window.
const db = require('./db');
const email = require('./email');

const NOTICE_KEY = 'account-created-notice-v1';
const DEFAULT_MAX = 100;       // Resend free tier: 100/day
const DEFAULT_GAP_MS = 500;    // <= 2 sends/second
const MAX_CONSECUTIVE_ERRORS = 3;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const validDate = (s) => DATE_RE.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Accounts created in [since, until] (dates, UTC, inclusive) that have no ledger row yet. Fixtures and password-less rows excluded. */
function candidates({ since, until, only, limit }) {
  const where = ['u.is_fixture = 0', 'u.password_hash IS NOT NULL', 'u.created_at >= ?',
    'NOT EXISTS (SELECT 1 FROM sent_notifications n WHERE n.user_id = u.id AND n.dedupe_key = ?)'];
  const args = [since, NOTICE_KEY];
  if (until) { where.push("u.created_at < date(?, '+1 day')"); args.push(until); }
  if (only) { where.push('lower(u.email) = ?'); args.push(String(only).toLowerCase()); }
  let sql = `SELECT u.id, u.email, u.created_at FROM users u WHERE ${where.join(' AND ')} ORDER BY u.created_at ASC, u.id ASC`;
  if (limit) { sql += ' LIMIT ?'; args.push(limit); }
  return db.db.prepare(sql).all(...args);
}

/**
 * opts: { since, until, only, limit, send, max, gapMs, sleep }. Returns a summary and never throws for
 * expected conditions; a refusal comes back as { refused: '<reason>' } with nothing sent.
 */
async function run(opts = {}) {
  const { since, until, only, limit, send = false, max = DEFAULT_MAX, gapMs = DEFAULT_GAP_MS } = opts;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (since && !validDate(since)) return { refused: '--since must be YYYY-MM-DD' };
  if (until && !validDate(until)) return { refused: '--until must be YYYY-MM-DD' };
  if (send && !since) return { refused: '--send requires --since=YYYY-MM-DD' };
  const rows = candidates({ since: since || '0000-01-01', until, only, limit });
  const out = { mode: send ? 'send' : 'dry-run', matched: rows.length, sent: 0, failed: 0, skipped: 0, aborted: null,
    preview: rows.map((r) => ({ to: email.maskEmail(r.email), created_at: r.created_at })) };
  if (!send) return out;
  if (rows.length > max) return { ...out, refused: `${rows.length} recipients exceeds --max=${max} (Resend free tier is ${DEFAULT_MAX}/day); narrow the dates, use --limit, or raise --max` };

  let consecutive = 0;
  for (const r of rows) {
    const notMe = require('./account-email-tokens').issue(r.id, 'not_me'); // 14-day single-use "not me" link
    const res = await email.sendAccountCreatedNotice({
      notMeUrl: email.linkFor('/not-me', { token: notMe.token }),
      to: r.email,
      signInUrl: email.linkFor('/'),
      helpUrl: email.linkFor('/reset-password'),
      idempotencyKey: `${NOTICE_KEY}-${r.id}`,
    });
    if (res && res.ok) {
      db.markNotificationSent(r.id, NOTICE_KEY);
      out.sent++; consecutive = 0;
    } else if (res && res.skipped) {
      out.skipped++; out.aborted = 'RESEND_API_KEY is not set; nothing was sent or recorded'; break;
    } else {
      out.failed++; consecutive++;
      if (consecutive >= MAX_CONSECUTIVE_ERRORS) { out.aborted = `stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors (last: ${(res && res.error) || 'unknown'})`; break; }
    }
    await sleep(gapMs);
  }
  return out;
}

module.exports = { run, candidates, NOTICE_KEY, DEFAULT_MAX };
