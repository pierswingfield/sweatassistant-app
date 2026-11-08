# Teams dashboard refinements — 2026-11-07

Verified in the user's real Google Chrome through CDP 127.0.0.1:9222. Local app uses the isolated `/tmp/dibs-teams-ux.db`; no live gym writes. Gemini Flash performed three locator calls over required project/infrastructure docs and source; source claims were checked at the actual symbols before editing.

## Checks and output

- Node v22.23.4 `npm test`: **120/120 server suites passed**; **117 client files / 959 tests passed**.
- After metadata photo hydration: `npm run test:client`: **117 files / 959 tests passed**.
- Final focused dashboard suite after accessible period label and token correction: **15/15 tests passed**.
- `node server/test-team-stats.js`: **11/11 passed** (equal rolling 14-day windows, boundaries, growth ordering, sparse/empty data and private/unlinked data exclusion).
- `node server/test-team-privacy.js`: **59/59 passed**, including real-DB instructor identity exclusion for recent-sharing off, viewer-unlinked gym, disabled member link, paused member and removed member.
- `npm run build:client`: **built**, existing Vite large-chunk and mixed-import warnings remain.
- `git diff --check`: no output, exit 0.

## Browser evidence

[Baseline](before.png): completed Today labels used location text, Week selected a day automatically and exposed rows.

[320px timezone fixture](timezone-320.png): completed and upcoming time columns both x=67, width=40; ET suffix centered below the time; both gym logos present; document overflow false. The fixture renders a synthetic upcoming New York class through the real widget function without writing a booking. Long class/instructor labels wrap within the available width.

[320px trends](trends-320.png): real local API aggregates show Adam 8 versus 5 (+3), Aaron Reid 3 versus 0 (+3), Iris 3 versus 0 (+3), horizontal growth bars and gym logos; stats precede Members. Mock instructor metadata has no photo URLs, so initials are the correct fallback. The unit suite verifies matched cached metadata photo rendering and failed-image initials fallback.

Week initial DOM: zero `.tm-workout` rows, zero selected days, no See more, visible “Choose a day to see classes”. Explicit first-day click: three rows, See more present, aria-expanded true. Explicit selection persists on a widget repaint; no initial selection is invented. Day controls are focusable native buttons with aria-controls/aria-expanded. Real native keyboard dispatch was attempted but did not activate the hidden Chrome tab (locked desktop); keyboard activation and physical iOS remain unverified.

Trends count only completed, recent-shared, enabled-gym, viewer-linked entries from the existing privacy projection. They compare the last 14 rolling days with the previous 14, show at least two current shared class visits and positive growth, rank by absolute increase, and never rank members. Photos use only the app's existing normalized metadata API/cache for gyms already returned in that approved ranking. No raw provider calls were added.

## Deployment

Dev only, authorized from the teams branch. Pre-deploy remote `docker ps`: dev Up 3 days, tailnet bind 100.86.226.52:3005→3000. `docker diff sweatassistant-dev`: only A /data. WAL-safe backup `/data/pre-teams-dev-20261107-1794055039550.db`: integrity_check ok. Final commit/push/deployed hash and health evidence are recorded in PROGRESS-teams.md after deployment.

### Dev deployment receipt — 2026-11-07 12:44 UTC

Code commit `3b50506f6f112beb3d8e76f8a603826703228fe9` on `teams` was pushed as a new `origin/teams` branch (authenticated GitHub CLI HTTPS credential path; SSH transport had no loaded key). Remote ref and local code SHA matched exactly. Deployed an immutable git archive with the default `./deploy.sh` to `sweat-dev.wingfield.tech` only; bulk QA/source art and local mock fixture utilities were omitted from the artifact. No master merge or prod/experiment deploy.

Actual remote output:

```text
sweatassistant-dev | Up 37 seconds | 100.86.226.52:3005->3000/tcp
sha256:bf9f61d54b0c573dd48cf9d6806a978281c28081aaf0d86d2ace6710dcb7dcce RestartCount=0
v22.23.4
arm64
docker diff: A /data
DEPLOYED_COMMIT: 3b50506f6f112beb3d8e76f8a603826703228fe9
public /api/health: HTTP 200, status ok
tailnet /api/health: HTTP 200, status ok
scheduler/poller/calendar: healthy true
```

Served asset SHA-256 matches the local verified build (tailnet and real Chrome public-origin fetches):

- `index-B7gQFeH0.js`: `183499c37fdf12e772bbac8052f2a3157ce676c27c75ad59bb8f21b992b3d490` — match.
- `index-BZ1ApP9J.css`: `4e9cc73d92fbd07014c4b17750b1f5b3cc0a5861f7a8a5ac18634af520145df5` — match.
- `teams-dashboard-CN-jp5y_.js`: `a6eb848c3b2b8783ba50fb50e3dba7e92c15e547136a58a6ee8c74b0e5ea0b99` — match.

Real Chrome after clearing SW/CacheStorage/IndexedDB and reloading the public dev Teams route loaded the new `index-B7gQFeH0.js`; all three asset fetches returned 200 and matching hashes. It displayed the login screen with no document overflow at 402px. Neither existing dev tab nor the verification tab has a signed-in app session, so authenticated dev dashboard interaction remains unverified; the full dashboard behavior is verified against isolated local mocks, with deployed byte identity proven. No credentials were minted or changed for verification. Registry and Server Management CHANGELOG updated in this turn. Large prior QA captures and source PNGs remain untracked.
