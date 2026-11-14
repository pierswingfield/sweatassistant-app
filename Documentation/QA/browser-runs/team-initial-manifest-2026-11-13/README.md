# Initial HTML Team invite handoff — 13 November 2026

## Cleanup release — 13 November 2026, 21:36 UTC

Experiment was rebuilt to invalidate an initial server-rendered continuation when an already signed-in visitor reaches the invitation or logs out, even if client preparation never ran. It deduplicates an identical saved continuation and handles distinct handoffs independently. The initial-manifest mechanism and auth-first fallback remain in place.

Container `db5916b870264877a7459f5c529d4e0eabc7786d5708829fd50c390c38ab71ed` runs ARM64 image `sha256:6a25f2428975a11d71236408bb873111dca9ea350f4c6cdbd1e26d990deb3c86`, Node `v22.23.4`, restart count 0; internal and public health returned HTTP 200. Read-only SQLite integrity was `ok`, with 14 users / 18 gym links / 4 Teams / 0 pending signup rows immediately before and after deployment. Env/compose hashes, `100.86.226.52:3006` bind, networks and prod/dev/landing container IDs and start times were unchanged. Fixture 16 remains in the database, but is **not** signed in on the phone after the owner deleted the PWA and Safari storage was cleared. Account 13 is preserved.

The running helper SHA-256 is `18e30df5d4369175c97bad4413a2f7b8050b8062cdd4bc73be8db3cfd3515968`; the served `index-CaEQJezN.js` is `b8ad5d9afa7aa4cc236baf975cd72b84a50d922130969c879b4defe2bf91b673`. Server and Team module hashes remain unchanged. All 57 local build files other than the worker match runtime files; two retained Homerun WebPs are additional. The worker returned HTTP 200 and contains the no-store guard; it matches local after normalizing the build stamp and those two remote-only precache entries. The full run passed 129/129 server suites and 1,032 client tests; build passed with the existing chunk-size warning. [Tests](cleanup-test-output.txt), [build](cleanup-build-output.txt), [deployment](cleanup-deploy-output.txt).

Fresh rollback is `~/services/sweatassistant-experiment/rollback-ssr-cleanup-20261113/` (mode 700), with WAL-safe DB backup, env, compose and source archive; `sweatassistant-experiment:rollback-ssr-cleanup-20261113` points to the prior `3099115c…` image. The pre-auth physical evidence below remains bounded: actual PWA launch carried a continuation query and the corresponding row disappeared, and the owner confirmed that the first PWA screen displayed the invitation to join the intended Team. Full physical signup-to-welcome remains pending. A supporting iPhone WebKit emulation of the prior build reached Team preview before authentication, signup, welcome and a normal root relaunch with no replay; this is not a physical end-to-end pass of this cleanup release.

## Release

Deployed the reviewed, uncommitted `fix/home-team-join-2026-11-12` working tree at HEAD `d4c8233` to Oracle `sweatassistant-experiment` only. A Team invite shell now has an opaque install-continuation URL and a hash marker in the initial HTML manifest link, available before the client starts. The handoff uses the existing hashed continuation storage and same-shape private HTML for valid and invalid invites. The change reuses the manifest link and does not issue an extra continuation request from the client. Existing auth-first fallback remains.

The owner has now installed and opened the PWA before logging in or creating an account. The evidence below supports anonymous handoff capture and redemption; the owner has confirmed the visible Team preview; the full signup-to-welcome flow remains **unverified**. No actual invite URL or token was fetched during the deployment checks.

## Physical iPhone progress

After deleting the PWA and clearing Safari app storage, service workers, CacheStorage and IndexedDB, the owner opened a Team invite. The initial HTML had the opaque manifest and marker; the client reused it without authentication. The manifest had root `id` and scope, a continuation start parameter and no raw Team token, with no-store headers. See [initial Safari state](ssr-safari-before-install.json), [manifest checks](ssr-safari-manifest-before-install.json) and [screenshot](ssr-safari-before-install.png).

The owner used Add to Home Screen **before** authentication and opened the installed PWA. The inspector's last cached target listing showed root with a `teamContinuation` query key; it was not a live DOM snapshot because the USB connection ended. The matching previously unexpired continuation row was present before installation and absent afterward, while counts stayed at 14 users and zero pending signups. Together these observations support that the anonymous launch carried and redeemed the handoff. The owner subsequently confirmed that the first PWA screen displayed the intended Team invitation before authentication; the inspector listing itself is not a live DOM snapshot. [Sanitized evidence](preauth-install-evidence.json). Full signup after pre-auth installation remains pending. Preserve fixture 16 and the original account 13.

The original HTML byte-identical contract is refined to equal-shaped opaque HTML without a validity signal: every response has a fresh random continuation, valid or invalid. Continuations have a 24-hour TTL and a 10,000 active-row ceiling; capacity fails closed without evicting live handoffs. The service worker excludes Team routes and honors `no-store` for shell caching. A mismatched Team marker triggers at most one guarded hard reload and fails closed thereafter. The auth-first fallback remains in place.

## Checks

- Final `npm test`: 129/129 server suites; 128 client files / 1,028 tests passed.
- Client build passed in 951 ms with the existing Vite chunk-size warning.
- `git diff --check` passed.
- Build and test logs are in [build output](build-output.txt) and [test output](test-output.txt).

## Deployment and runtime

- Image: `sha256:3099115cad22786f088c6733212d5aea4e975beb482e08ef0a72726f53afd638`.
- Container `a194576bb3cc6aa498ec59054e900e561cf16748ba46b3ae35b7f57b661697d8`: ARM64 / Node `v22.23.4`, Up, restart count 0.
- Existing `100.86.226.52:3006->3000` tailnet bind, `edge` and project networks are unchanged.
- `.env` SHA-256 `af4c5b2007b805118fd528a5d224475461ab11cd28b58b2367f6d0ebfa8c176c`; compose SHA-256 `322b8ddeb92234824c61281a026974f4e5adca2a2cb8721d426351f735519475`; both unchanged.
- Public and internal health returned HTTP 200. SQLite integrity is `ok`; 14 users / 18 gym links / 4 teams / 0 pending signup-onboarding rows were preserved. No schema change occurred.
- Runtime `server/server.js`, `server/teams.js`, and `client/src/team-invite-intent.js` match the reviewed local source hashes. Main asset `index-BgsxdgX5.js` was fetched from the running container with HTTP 200, 753,494 bytes, SHA-256 `82233f1402d48318b872a93171b89931b612518a75dd287dff56e8018c7792a2`, matching local build output.
- A subsequent independent Docker inspection reconfirmed the full image and container IDs, ARM64 architecture, Node version, zero restarts and bind/networks; internal and public health were both HTTP 200. The three selected runtime source hashes match the local checkout and the served main bundle hash matches the build. No complete source or asset inventory was independently compared in this follow-up. Read-only DB output: `users=14`, `user_gyms=18`, `teams=4`, `team_signup_onboarding=0`, `integrity=ok`. The rollback directory has mode 700; environment and compose hashes match those above.
- A further static inventory compared every file in local `client/dist` except `sw.js` against runtime `server/public`: **57/57 matched SHA-256**, none missing or mismatched; the runtime additionally retains the two Homerun WebP files. Internal HTTP `GET /sw.js` returned 200 and showed the `Cache-Control: no-store` guard in `cacheCoherentShell`. Normalizing only each worker's build-stamp string gives local SHA-256 `7185fb70cb19d4e60676862e280fc77da4ee244f07f5597eae7394f337e0960d` and runtime `c613092a5ffc984fd8f97d249580689a00fc931d984ead265af61f2a2054cfdf`: they differ because the runtime precache also lists those two retained WebPs. No full source inventory was independently compared.
- Generic shell GET `/` returned HTTP 200 and `Cache-Control: no-cache`; it used the ordinary `/manifest.json` href. This does not verify the invite-specific initial HTML. The runtime worker is build-stamped.
- Production, dev and landing container IDs and start times remained unchanged.

See [deploy output](deploy-output.txt) and [runtime verification](deploy-runtime-output.txt).

## Rollback

The predeploy WAL-safe database, environment, compose, remote source snapshot and prior ARM64 image are retained at `~/services/sweatassistant-experiment/rollback-initial-manifest-20261113/`; prior image tag `sweatassistant-experiment:rollback-initial-manifest-20261113` points to image `sha256:877d245f33e6ce73b64b62518b3a513a798b1c0f09aaf7120fda6b402db2bae5`.

Production, dev, landing, DNS, Cloudflare Access, binds and networks were not changed. No live gym/provider writes occurred.
