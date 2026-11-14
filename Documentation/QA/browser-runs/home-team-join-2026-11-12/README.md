# Home and Team join release — 12 November 2026

Source: `fix/home-team-join-2026-11-12`, based on `master` `8b3968b`. This release targets the existing experimental service only.

The existing personal statistics charts remain. The prior attendance-count card is restored as a separate `attendance` widget immediately after them, with per-gym counts and the all-gym total. Credits & passes is last on mobile and desktop. [Home browser evidence](../../../Workstreams/HOME-ATTENDANCE-RESTORE-2026-11-12.md).

Team invitations take priority over setup for an existing account. Signed-out visitors see the Team's name and emoji above the welcome content; login reaches the invitation directly, while a new signup completes onboarding first. Saved valid first and last names skip the name step. The invitation remains a request with explicit sharing choices; the continuation never creates membership or submits a request.

Install feasibility: a separate opaque 256-bit continuation has a 24-hour lifetime and is stored only as a hash on the server. A per-install manifest keeps the existing `id` and `scope` (`/`) and supplies the continuation in `start_url`. Redemption is atomic and single use, persists across server restarts, and returns no invitation after expiry, use, invite rotation or disabling. Ordinary launches silently ignore old tokens; a replay must not clear a newer pending invitation. Browser completion also invalidates its unused install continuation. Temporary HTTP/network failures retain the launch URL for retry.

This uses the manifest's separate [identity and preferred start URL](https://www.w3.org/TR/appmanifest/); [Chrome documents stable identity when start URLs change](https://developer.chrome.com/docs/capabilities/pwa-manifest-id), and [WebKit documents manifest ID support](https://webkit.org/blog/13878/). Whether a particular iOS installation captures the dynamic manifest requires a physical-device check. Local Chrome verification of a fresh storage launch establishes the application handoff, not a physical iPhone installation result.

Baseline verification found one unrelated date-dependent failure: `npm test` reported `1/125 server suites FAILED`, with `team-privacy` at `58/59 passed`. Its fixed 10 November fixture reached a cache reader with a real-time 24-hour cutoff. Pinning the clock only around that test assertion produced `59/59 passed`; application cache behavior is unchanged.

Before deployment, 475 remote application/source files matched the starting checkout. Six differences were inspected: the already-approved empty statistics paragraph removal and its test, plus trailing blank lines. Two remote-only old Homerun image assets were identified. There was no unknown server hotfix to overwrite.

Combined verification (Node 22.23.4):

```text
npm test
126/126 server suites passed.
Test Files 126 passed (126)
Tests 1007 passed (1007)

npm run build:client
✓ built in 908ms

git diff -p --check
exit 0
```

The build retains the existing mixed-import and large-chunk warnings. [Full test output](test-output.txt), [build output](build-output.txt), and [Team browser evidence](TEAM-JOIN.md). Seven Chrome checks cover logged-in nonmember entry, signed-out Team preview, returning login, new signup with a reload during setup, no implicit membership request, a fresh-storage one-use handoff with replay, and saved-name skipping. Home has separate mobile and desktop Chrome evidence. These are local fixture flows; no live gym booking or account mutation was needed.

Gemini provenance: the root used Gemini Flash for two bounded instruction/reference locator calls and a grounded call for manifest feasibility. The relevant claims were checked against repository source and the primary documentation linked above; uncited browser-install assumptions were not accepted as device verification. Sol implemented the Team flow, Terra restored Home, and Luna owns the experimental deployment.

Luna deployed with `./deploy.sh --experiment`. [Deploy output](deploy-output.txt) reports 135 modules transformed, successful build and recreation of `sweatassistant-experiment`. [Runtime verification](deploy-runtime-output.txt) records:

```text
sweatassistant-experiment: Up, restart 0
image sha256:8247887fc441e39f811f5d30a8f055d6d03a1dfae8dbdda87ce2f4e757da5de1
ARM64, runtime_node=v22.23.4
internal/public health HTTP 200, status ok
scheduler/poller/calendar healthy
SQLite integrity: ok
12 users | 18 gym links | 3 Teams
```

Environment/compose hashes, bind `100.86.226.52:3006->3000`, and `edge`/project networks are unchanged; `docker diff` reports only `A /data`. Prod, dev and landing IDs/start times are unchanged. The WAL-safe rollback backup passed integrity checking; private database/config records and the previous image are retained under `~/services/sweatassistant-experiment/rollback-home-team-join-20261112/` and tag `sweatassistant-experiment:rollback-home-team-join-20261112`.

Post-deploy comparison verified all 537 local server/client source entries on the host and all 490 runtime server/client-source files in the container. All 57 non-service-worker production asset files match the local build. The remote service worker also precaches the two retained, previously reviewed Homerun WebPs; its build stamp/precache therefore differs from the local build. This is a known asset-list difference, not an unreviewed application-source change.

The reused Chrome tab reached Cloudflare Access (`Log in to Dibs experiment (Piers)`). No credentials or verification code were entered; authenticated deployed app UI was not checked. The seven user-flow checks above were local real-Chrome checks. Public `/api/health` independently returned `status: ok`, and the host/container verification establishes the deployed source/assets. The signed Access redirect URL is omitted from browser evidence. Physical iPhone installation remains unverified.
