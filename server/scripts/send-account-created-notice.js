#!/usr/bin/env node
// One-off neutral "your account has been created" SERVICE email to existing accounts created
// since a date. Purely transactional (states the account exists, the sign-in URL and what to do
// if it was not them): no promotion, no tracking, no token. Logic: server/account-created-notice.js.
//
//   node server/scripts/send-account-created-notice.js --since=2026-10-01            # DRY RUN (default): count + masked list, sends nothing
//   node server/scripts/send-account-created-notice.js --since=2026-10-01 --only=me@example.com --send   # one test recipient
//   node server/scripts/send-account-created-notice.js --since=2026-10-01 --until=2026-11-16 --send
//
// Flags: --send (required to mail anyone, and needs --since), --since/--until=YYYY-MM-DD (UTC,
// users.created_at, both inclusive), --limit=N, --only=<email>, --max=N (default 100; a send run
// refuses more recipients than this). Sends at most 2/second, stops after 3 consecutive errors,
// and records each success in sent_notifications (key account-created-notice-v1) so re-runs never
// re-mail anyone. Needs RESEND_API_KEY (+ EMAIL_FROM, PUBLIC_HOST/PUBLIC_ORIGIN) in the environment.
//
// On the prod container (review the dry run first):
//   docker exec sweatassistant node server/scripts/send-account-created-notice.js --since=2026-10-01
//   docker exec sweatassistant node server/scripts/send-account-created-notice.js --since=2026-10-01 --send
const dbm = require('../db');
const notice = require('../account-created-notice');

function parse(argv) {
  const o = {};
  for (const a of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) { o._bad = a; continue; }
    o[m[1]] = m[2] === undefined ? true : m[2];
  }
  return o;
}

(async () => {
  const a = parse(process.argv.slice(2));
  const known = new Set(['send', 'since', 'until', 'limit', 'only', 'max']);
  const unknown = Object.keys(a).filter((k) => k !== '_bad' && !known.has(k));
  if (a._bad || unknown.length) { console.error(`Unknown argument: ${a._bad || '--' + unknown[0]}`); process.exit(2); }
  const num = (v) => (v === undefined ? undefined : Number.parseInt(v, 10));
  const res = await notice.run({ send: a.send === true, since: a.since, until: a.until, only: a.only, limit: num(a.limit), max: num(a.max) || undefined });
  console.log(`${res.mode}: ${res.matched} matching account(s) with no notice recorded`);
  if (res.mode === 'dry-run') {
    for (const p of res.preview) console.log(`  ${p.to}  created ${p.created_at}`);
    console.log('Dry run: nothing sent. Add --send (and --since) to mail them.');
  }
  if (res.refused) { console.error(`REFUSED: ${res.refused}`); process.exit(2); }
  if (res.mode === 'send') console.log(`sent=${res.sent} failed=${res.failed} skipped=${res.skipped}${res.aborted ? `\nSTOPPED: ${res.aborted}` : ''}`);
  try { dbm.db.close(); } catch (_) {}
  process.exit(res.aborted ? 1 : 0);
})();
