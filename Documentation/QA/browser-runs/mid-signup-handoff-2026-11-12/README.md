# Mid-signup Team install handoff — local Chrome regression

Baseline (before source changes): real Google Chrome 156 via CDP, local backend and Vite with a disposable fixture database. A fresh signup via a Team invite reached gym setup; after clearing local storage, IndexedDB, caches, and service workers to simulate separate PWA storage, opening the original manifest start URL and signing in to that same account went directly to the Team invitation welcome. [Source setup](before-transfer-source.png); [wrong destination](before-transfer-login.png).

Command (baseline version of the script): `PATH=/Users/pierswingfield/.nvm/versions/node/v22.23.4/bin:$PATH TAB_ID=<shared-tab-id> node Documentation/QA/browser-runs/mid-signup-handoff-2026-11-12/handoff-cdp.cjs`. Output: `PASS signup reaches gym setup before transfer`, `OBSERVED step=intro setup=false welcome=true`, then `AssertionError: same new account must resume setup after separate-storage install` (`false !== true`). The script was subsequently extended for the remaining scenarios.

Physical iPhone installation has not been tested by this Chrome storage simulation.

Physical iPhone check pending (paired device available; native Add to Home Screen interaction requires the owner). Use fresh accounts created after the updated experiment release for the new-signup cases: older partial accounts have no new progress record. The existing-login case can use an existing account:

1. Open a Team invite in Safari, install before signup, and create an account in the installed app. Expected: setup begins before the Team welcome.
2. In Safari create an account from an invite, reach gym or optional setup, then install and open the app and sign in as that account. Expected: setup resumes at the saved step, then opens the Team welcome.
3. Open a Team invite and sign in as an existing account, including after install. Expected: Team welcome opens directly. Relaunch the installed app normally after reaching welcome; it should open the ordinary app without repeating the invitation.

After correction, using the same real Chrome and isolated fixture DB, with Node 22.23.4:

```
PATH=/Users/pierswingfield/.nvm/versions/node/v22.23.4/bin:$PATH TAB_ID=<shared-tab-id> FIXTURE_DB=/tmp/dibs-mid-signup-20261112.db node Documentation/QA/browser-runs/mid-signup-handoff-2026-11-12/handoff-cdp.cjs
PASS install before signup preserves Team and begins setup
PASS install after account creation resumes gym setup for the same account
PASS install during setup resumes the saved name step
PASS transfer and setup never request Team membership
PASS install during setup resumes the saved features step
PASS different existing account does not inherit new-account setup
PASS after welcome the old continuation opens the ordinary app
PASS reused continuation does not restore an invite
PASS expired continuation does not restore an invite
9/9 handoff browser checks passed
```

The expiration check changes only the disposable local fixture DB. See [gym setup](same-account-gym-setup.png), [features setup](same-account-features.png), and [different account](different-account-welcome.png). Results also appear in [handoff-results.json](handoff-results.json).

The copied existing-path suite `existing-paths-cdp.cjs` reported **7/7 Team join browser checks passed**: authenticated invite, signed-out preview, returning login, new signup, no implicit membership request, fresh-storage continuation/replay, and saved-name skip. This uses the same disposable fixture and shared Chrome tab.

An intermediate Chrome run caught a second failure: the regular login response supplied a gym profile ID (or null for a gym-less account) instead of the Dibs account ID. The saved progress existed, but the client could not associate it with that account. The login response was corrected and the 9/9 run above was repeated after that correction.

Failure handling was also checked in Chrome by intercepting only the authenticated setup-state GET with a simulated HTTP 500. Before the error-message correction, a valid login visibly showed `Incorrect email or password. Please try again.` After correction, `outage-cdp.cjs` produced:

```
OBSERVED login error: Could not load your setup. Please try logging in again.
PASS setup lookup outage reports retryable error and resumes after retry
PASS signup lookup outage confirms account creation and login resumes setup
```

The second check showed the account-created message and prefilled email, then successfully resumed gym setup on login after restoring the request. [Signup recovery screenshot](signup-outage-retry.png). The handoff suite was rerun with navigation waiting for a new document and again reported **9/9 passed**.

Implementation: successful new-account signup creates private setup progress for that Dibs account, Team and current invite hash in the same database transaction. The authenticated account can read, advance or finish only its own progress; existing accounts cannot create it through the progress API. The install continuation still carries only the invitation, with no account identity or session credential. Both records expire after 24 hours. Progress writes are best-effort: a failed save can resume an earlier saved step on another device. Finishing setup waits for server confirmation before opening Team welcome. Reused install URLs do not restore completed setup or invitations.

Final combined checks, against frozen application source with Node 22.23.4:

```text
npm test
127/127 server suites passed.
Test Files 126 passed (126)
Tests 1010 passed (1010)

npm run build:client
✓ built in 1.08s

git diff -p --check
exit 0
```

See [test output](test-output.txt) and [build output](build-output.txt). The build retains existing mixed-import and chunk-size warnings. An earlier client run reported `1009 passed, 1 failed` because the new retry text bypassed the shared copy catalog; the strings were moved into that catalog and the full command above rerun successfully. The new server suite reports **5/5** account-bound signup checks; existing continuation checks report **7/7**. Login identity tests cover a gym-less account, an account whose gym profile has a different ID, and the development mock.

Physical-device discovery reported a paired, available physical iPhone. Its Web Inspector inventory returned no inspectable pages. No physical Safari installation flow was completed; the three checks above still require native Add to Home Screen interaction.

Experiment deployment at 11:30 UTC used image `sha256:da15b49686e182b71a786bf2345286e7c905b0a6769d12937a66a4369a2ac879`. [Deploy output](deploy-output.txt), [runtime proof](deploy-runtime-output.txt) and [source/asset comparison](deploy-source-asset-verification.txt) show:

```text
sweatassistant-experiment: Up, restart 0
ARM64, Node v22.23.4
Internal/public health HTTP 200, status ok
Scheduler/poller/calendar healthy
SQLite integrity ok; 12 users / 18 gym links / 3 Teams
team_signup_onboarding exists; user/Team foreign keys cascade; 0 initial rows
538 host source files / 491 runtime source files / 57 static assets match
```

Environment/compose hashes, bind/networks and production/dev/landing IDs/start times are unchanged. The service-worker stamp differs between the local and remote builds; the two previously reviewed remote-only Homerun WebPs remain. WAL-safe rollback DB/config/source and the previous image are retained at `~/services/sweatassistant-experiment/rollback-mid-signup-20261112/` and tag `sweatassistant-experiment:rollback-mid-signup-20261112`. Public root redirects to Cloudflare Access; authenticated deployed UI was not agent-verified.

The owner confirmed availability for physical iPhone testing after deployment and was sent the mid-signup Safari → Add to Home Screen → same-account login scenario. Its result is awaiting the owner's observation. The preserved counts above were measured before these owner-operated tests; any subsequently created test accounts must not be mistaken for deployment data loss or automatically removed.

## Follow-up: separate session storage

A later owner iPhone test found that setup finished without opening the Team welcome. On follow-up Chrome testing, the earlier harness was found to clear localStorage, IndexedDB, CacheStorage and service workers, but **not sessionStorage**. Its `appReturnTo` value could preserve the Team route and mask a lost intent. The earlier pass therefore did not prove recovery when both the launch query and both storage areas are absent. The follow-up harness clears localStorage **and sessionStorage**, along with IndexedDB, CacheStorage and service workers; see the [intent-loss receipt](../mid-signup-intent-loss-2026-11-12/README.md).
