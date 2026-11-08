# Private personal statistics — verified dev release

2026-11-08, user explicitly requested “push to dev” after local review. **Dev only. Production, experiment, marketing, DNS, Cloudflare, mail and exposure configuration were not changed. No master merge.**

Source: `46cd27c223853c9130be853c978f2bb004694a42` on `teams`, pushed non-force to GitHub. GitHub SSH identity was unavailable; used the existing `gh` HTTPS credential helper per command without changing the remote. Included app/tests, approved brief and focused design/local verification evidence; unrelated untracked artwork and older QA were not staged.

## Source and deployment

The source matched the previously verified [implementation patch](../personal-stats-implementation-2026-11-08/implementation.patch) exactly. Retained results on unchanged application source: **122/122 server suites; 122 client files / 981 tests; client build passed**. Initial obsolete client expectations and their correction remain documented in the [local receipt](../personal-stats-implementation-2026-11-08/README.md).

Created a runtime-only `git archive` export at `/tmp/dibs-dev-release-46cd27c`, containing committed server/client/build/deploy inputs. It excluded `.env`, databases, dependencies, source artwork, documentation/QA and local mock/seed scripts. Built this immutable source locally under Node 22.23.4, then ran its inspected `./deploy.sh --dev --print` and `./deploy.sh --dev`. Only `~/services/sweatassistant-dev` was synchronized/rebuilt. The host's existing `.env` and data volume were preserved. [Build output](immutable-build-output.txt) (964 ms, existing chunk-size warning) · [deployment output](deploy-output.txt).

## Preflight and data preservation

- Original dev source `964e04f812b2a82be8bdfcd971674ee4efe92fe4` recorded. Writable layer only `A /data`; 17G root free before build.
- Native SQLite `.backup` with WAL support, verified `PRAGMA integrity_check = ok`. Env/compose/old source marker saved privately; old image tagged `sweatassistant-dev:rollback-personal-stats-20261108`.
- Rollback directory: `/home/ubuntu/services/sweatassistant-dev/rollback-personal-stats-dev-20261108/`. Contains private DB/config/image records; none copied to Git or shipped with the release.
- Applied the exact additive schema change to a backup copy first: `class_history_sync.limited INTEGER NOT NULL DEFAULT 0`, integrity `ok`. Live post-start schema contains that column, integrity `ok`; no DB reset/recreation.
- `.env` SHA-256 `7852a01cd07a9ea2ec985caad8d06bee6a1080407a17427aeb7cf671e1c030f0` and compose SHA-256 `3379e7a8fd2d0e02001566cb4d31d3d773d3db588b107f78dcdec5752189aa1a` match preflight.
- Unchanged counts: **3 users, 6 gym links, 2 Teams, 2 Team members, 5 Auto-Book entries, 2 Auto-Upgrade entries, 3 push subscriptions**.
- Existing five gym enable flags retained. `PUBLIC_HOST=dev.dibs.fit` and permanent `CALENDAR_UID_NAMESPACE=sweat-dev.wingfield.tech` retained. No credentials/keys rotated, no agent booking/cancel/payment/setting/push/calendar mutations.

## Verification output

```text
sweatassistant-dev | Up About a minute | 100.86.226.52:3005->3000/tcp
state=running restarts=0
Node v22.23.4 arm64
internal /api/health: HTTP 200, status=ok
public /api/health: HTTP 200, status=ok
scheduler=true poller=true calendar=true
anonymous https://dev.dibs.fit/: HTTP 302 (Access retained)
unauthenticated /api/personal-stats?zone=UTC: HTTP 401
.env: OK
docker-compose.yml: OK
PRAGMA integrity_check: ok
PROD_EXPERIMENT_UNCHANGED
```

Dev image `sha256:4fbaafea6a0bb9ff24585dbb9875fa756ffd8b6cee3283d7031f925ae2ac4b8a`, start `2026-11-08T02:09:46.075931899Z`. Existing dev `edge`/compose networking and tailnet bind preserved; no `0.0.0.0` bind. Production and experiment container IDs, image IDs and start timestamps compare byte-for-byte unchanged. Post-deploy writable layer remains only `A /data`.

Served over dev's existing tailnet endpoint and compared byte-for-byte with immutable local build ([complete hashes](asset-hashes.json)):

| Asset | SHA-256 |
| --- | --- |
| `index-CwzPpEIL.js` | `c5e771d53ce94b7742486870d1ac71f9904ee0086c8d1df1c84c613caff35a9e` |
| `index-Xo34H8Dp.css` | `243a2433a1fc6fd285d53c4df6703067738251481bb1774c566cdf468c111749` |
| `home-TlY5Saa3.js` | `4b6fc7ea07114b17652a24c531e906070e04dcc20510b20087c385d19ebaabb3` |
| `home-teams-Coa49N0w.js` | `a97d89913d33a368743bc9ac054215341676b7aee2f9fcc6dfeaefc04c464b16` |

Container `server/class-history.js` also matches committed local source. `DEPLOYED_COMMIT` written as the full source SHA above only after hash verification.

## Browser and limits

Opened one owned tab in the user's real Chrome through CDP 9222 at [dev.dibs.fit](https://dev.dibs.fit/). Existing Access session reaches the app; 390×844 screenshot shows `Welcome to Dibs Dev` and exact `I’m your boutique fitness concierge!` ([screenshot](dev-browser-390.png), [state](browser-state.json)). Closed that owned tab and preserved existing tabs.

The dev app account is signed out. No new sign-in or account/gym state mutation was performed; authenticated charts and setup behaviors retain the real-Chrome local fixture acceptance in the implementation receipt, rather than being claimed as reverified against live dev account history. Physical iOS/Android and live provider history completeness remain unverified. Provider 60-page guards still apply; personal charts describe past bookings, not certified attendance.

Updated current operations, workstream progress, self-host service registry and host change log in the same release turn. The subsequent receipt commit contains documentation/evidence only and is not a second deployment.
