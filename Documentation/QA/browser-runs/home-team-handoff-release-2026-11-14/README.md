# Home attendance and Team invite handoff release — 14 November 2026

## Release

Commit `afe5f1df2da2efa10a491a6e74587f1556c1deec` (`Restore Home attendance and protect Team invite handoff`) was pushed to `origin/master` and deployed to the existing Oracle DEV and PROD containers. Experiment and landing were not targeted. The release restores the Home attendance count and protects Team invitation continuation through signup/install/auth transitions, including stale-response race guards.

## Verification

- Node `v22.23.4`; `npm test`: **129/129 server suites** and **128 client files / 1,043 tests passed**.
- `npm run build:client` succeeded in 854 ms. Vite printed the existing mixed static/dynamic import and >500 kB chunk warnings.
- `git diff HEAD~1 --check` passed for source and documentation. Captured historical build/deploy logs in the committed evidence contain trailing whitespace; there are no source/doc whitespace findings.
- Both containers report internal `/api/health` HTTP 200 and healthy scheduler, poller and calendar. Public PROD and DEV `/api/health` returned HTTP 200.
- Both run ARM64 / Node `v22.23.4`, restart count 0. DEV keeps its `100.86.226.52:3005->3000` bind; PROD has no host port and remains on `edge`. `docker diff` before each recreate showed only `A /data`.
- The locally built main asset and each container's `/app/server/public/assets/index-iuCg2AGb.js` have SHA-256 `8d8c1abc6829441ca56cc9a480361b7100fc0a06ec1874530f4ef697de6d3936`. The public PROD asset returned HTTP 200 and the downloaded hash matched. The public DEV asset returned Cloudflare Access HTTP 302; its container copy matches the build. All **57 expected static files** (excluding `sw.js`) match exactly in both containers. DEV retains 28 extra legacy files in `server/public`; PROD retains two. No cleanup was attempted. Both served workers contain the `no-store` guard; their build stamps differ as expected.
- Selected unrelated runtime source hashes (`server/providers/marianatek.js`, `server/booking-sync.js`, `client/src/ui/upcoming.js`) match the pre-deploy local copies on both targets.
- `.env` hashes are unchanged: DEV `7852a01cd07a9ea2ec985caad8d06bee6a1080407a17427aeb7cf671e1c030f0`, PROD `1164a3553910d3ea240a9ee8adf14c16a7786f736020f4b6fd23e1ca9692f974`. Compose hashes are unchanged: DEV `3379e7a8fd2d0e02001566cb4d31d3d773d3db588b107f78dcdec5752189aa1a`, PROD `84a60708ad77090489a16291b12d380dc896e230a1c64dc40f7148adf0af1613`.
- SQLite `integrity_check` returned `ok` before and after. Counts before → after: DEV users 4, gym links 7, Teams 2, members 2, join requests 0; PROD users 3, gym links 6, Teams 2, members 2, join requests 2. The newly initialized `team_signup_onboarding` table contains 0 rows in each environment after deployment.
- Current container IDs/images: DEV `969cdc6fb4ff7bdd6f4d09b516c9ab1eefcb9d4dd21287041d70800cae287064`, image `sha256:70d2ee38b267e8b497bf499504af4ff87a0a0c6bedf7a91fa1d91cab0f1db222`; PROD `0b96815f7e27c9d126b49d9e11a37123f1170b9bc0d95448dfdc9e735b52798a`, image `sha256:ddaf59d0e7945eb77b6d5554285e760a98bf4c2cb1f7d489ab93cdcda9aceacd`.
- Experiment stayed on container `240cac7f079f1d0d9946f22dcbb5f879d94c97640812bc54a65facd88245de58` / image `sha256:beebdd00ebf2561702f9fb9584a7b0c2d85e1fb6468208d2e8a0779a191510be`; landing stayed on container `97d51a0737d4fff3b28970358a2227ffa84ece662842f4dca12cdcfaa10e0004` / image `sha256:8658870566c2e458ba362c44b33673c1d48728e1820956efb0bfed21ac9c6375`.

The owner confirmed the Team preview in the PWA installed before signup. Full physical signup-to-welcome for that installation timing remains unconfirmed; supporting WebKit full-flow checks passed. No fresh PROD/DEV interactive browser or device acceptance was run during this promotion.

## Rollback

Each target has a mode-700 snapshot directory with WAL-safe SQLite backup, `.env`, compose file and source archive:

- `~/services/sweatassistant-dev/rollback-home-team-handoff-20261114/`; prior image tag `sweatassistant-dev:rollback-home-team-handoff-20261114` (prior digest `sha256:1c9a96fd822df02598b95adbc02456e062197fd32316284ccb5700c7c5c52b5a`); backup integrity `ok`, SHA-256 `fdd6de7607545890ea18aee65f39a1cf2d2481529fa6ccdee8990dce9d2d8c30`.
- `~/services/sweatassistant/rollback-home-team-handoff-20261114/`; prior image tag `sweatassistant:rollback-home-team-handoff-20261114` (prior digest `sha256:3acae9e859d1c6967299464671fe2eaaf22bd7ba299cc0a167538aa16302c36c`); backup integrity `ok`, SHA-256 `79ff7fac6e06710e731fe3cc91428c2b2ff97914d39dccbbc0991b686ccb4ddc`.

No gym/provider writes were performed. Production/dev account data, secrets, binds, networks and exposure settings were preserved.
