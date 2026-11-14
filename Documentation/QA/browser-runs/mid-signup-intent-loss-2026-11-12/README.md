# Team intent loss after iPhone installation — 2026-11-12

Owner physical observation: a Team invite signup in Safari followed by Add to Home Screen and login in the installed app reached gym setup, but finishing setup did not show Team welcome. A gym-less account can reach gym setup without any Team context, so that screen alone does not establish that the invite survived.

Before the fix, Chrome 156 via the user's CDP session reproduced the loss with a local disposable database: Team signup → clear localStorage, sessionStorage, IndexedDB, CacheStorage and service workers → open ordinary `/` with no query → sign in to the same account → complete gym, name and feature steps. The result was `/` Home with `welcome: false` and an assertion failure (`false !== true`). [Source gym setup](before-source-gym-setup.png); [Home instead of Team welcome](before-lost-team-welcome.png). An initial trial falsely passed because sessionStorage still contained `appReturnTo`; the corrected baseline cleared it.

This simulation does not replace a physical iPhone installation. If installation occurs before account creation and both the invite and launch token are lost, there is no account identity to associate with a Team; this case cannot be recovered from account-bound state.

After the fix, real Chrome on the same local fixture passed `intent-loss-cdp.cjs` with Node 22.23.4, the shared CDP tab, and `FIXTURE_DB=/tmp/dibs-lost-team-20261112.db`:

```
PASS same account recovers lost intent and sees welcome without joining
PASS ordinary relaunch after welcome does not replay invite
PASS explicit Team B invite takes precedence over pending Team A
PASS existing onboarding-complete marker does not suppress pending Team setup
PASS wrong account cannot recover another account intent
PASS disabled invite is not recovered
PASS rotated invite is not recovered
PASS expired pending signup is not recovered
PASS transient lookup failure retains intent for retry
9/9 loss recovery browser checks passed
```

Completion was also checked against the authenticated pending-state endpoint: it returned no remaining step or invite for the completed account. The no-Team-replay check allows the app's existing gym-less startup behavior: it can show the onboarding intro on a later ordinary launch. In the explicit-Team-B case, the separate, unfinished Team-A setup remains pending; the explicit Team B is shown first and the account can later recover its unfinished A setup. The expiration case modifies only the disposable fixture DB. See [recovered welcome](after-recovered-welcome.png) and [results](intent-loss-results.json).

The previous launch-query suite was repeated after adding sessionStorage clearing to its reset: `query-token-cdp.cjs` reported **9/9 handoff browser checks passed**, covering pre-signup installation, saved gym/name/features steps, different account, completion, replay, and expired continuation. These checks simulate isolated storage and do not establish native iPhone installation behavior.

The authenticated fallback reads only the current account's unfinished signup record when no explicit or stored invitation is present. It validates the 24-hour expiry, Team invite-enabled flag and current invite hash before returning the saved step and verified invitation. Explicit Team links take precedence. No authentication credential is transferred through installation, and no membership request is submitted automatically. Completing setup removes the pending record before showing the invitation, so a completed invitation is not recovered on later launches. No schema change was required.

Final checks against frozen source, Node 22.23.4:

```text
npm test
127/127 server suites passed.
Test Files 126 passed (126)
Tests 1014 passed (1014)

npm run build:client
✓ built in 1.47s

git diff -p --check
exit 0
```

[Full test output](test-output.txt) and [build output](build-output.txt). Existing mixed-import and chunk-size warnings remain. The server recovery checks include unauthenticated rejection, no-store responses, ownership, completion, disabled/rotated invites and expiry. The owner can retest using the already-created account; a server read after the failure found its pending setup still at `gyms`. The fresh deployment preservation baseline is 13 users, 18 gym links, 4 Teams and 1 pending signup row, including owner-operated testing after the preceding release.

Luna deployed the correction to experiment at 12:22 UTC: image `sha256:2534e69e9e932969e41ea651fce3bd042ea8934bcb675e5754e5aa4a3bb2f27c`, container Up/restart 0, ARM64/Node 22.23.4. Internal/public health returned HTTP 200 with healthy scheduler/poller/calendar. SQLite integrity `ok`; 13 users/18 links/4 Teams and the one pending owner signup row preserved before retest. Environment/compose hashes, bind/networks, and production/dev/landing identities/start times are unchanged. All 538 local source files, 491 runtime source files and 57 non-service-worker static assets match; the two known retained WebPs and per-build worker stamp remain the documented differences. [Deploy output](deploy-output.txt), [runtime proof](deploy-runtime-output.txt), [source/asset proof](deploy-source-asset-verification.txt).

The authenticated fallback rejects unauthenticated requests with 401; authenticated private data has no-store coverage in the server tests. Public Chrome reached Cloudflare Access, then the QA tab was closed; no credentials were entered. The owner was asked to fully close/reopen the installed experimental PWA, sign in to the same account if needed and finish/skip setup again. The physical retest result is pending. Private WAL-safe DB/config/source/image rollback is preserved at `~/services/sweatassistant-experiment/rollback-signup-intent-loss-20261112/` and tag `sweatassistant-experiment:rollback-signup-intent-loss-20261112`.
