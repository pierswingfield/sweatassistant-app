# Teams: progress report

**As of 2026-11-07.** Branch `teams` (58 commits ahead of `master`, latest the surname-initial work after `6fedd1a`). Nothing is pushed to `master` or deployed to prod. The experiment twin was redeployed 2026-11-07 04:02 UTC with the UX revision below, from the uncommitted `teams` worktree based at `62a620c`.

Full design and decisions: [PLAN-teams.md](PLAN-teams.md). Screenshots are linked below (open them from the repo).

## UX revision deployed — 2026-11-07 04:02 UTC

Implementation followed [the revision brief](TEAMS-UX-REVISION-2026-11-07.md), preserving the dirty Teams worktree. No commit, push, production/dev deployment or live booking/sharing/membership write was performed. Gemini Flash made two successful retrieval calls for the brief/instructions and progress/deploy-reference map; source claims were then checked directly. No substitute model was used.

### Changes and acceptance checklist

| Request | Implementation and evidence |
|---|---|
| Nested Settings → every main tab | Explicit active Settings scroll state scopes nested-pane geometry. Departure clears swipe transforms. The fixed header is reserved once; nested-pane extra padding is zero. Direct route/back/forward resets internal pane history instead of accumulating stale sections. Chrome: About/General/Privacy/gym → Home/Timetable/Bookings/Teams at 390/402px, destination scrollTop 0 and no retained lock; Account bottom 717px above nav. Back header top equals fixed header bottom (41px locally). |
| Today restored selectively | Original timeline composition: left time, class/location, attendee line; live progress ring/time range; no instructor column. Completed tick and collapsed attendees, whole-row expansion with aria-expanded/inert, refresh persistence and reduced-motion support retained. Deployed normal completed row measured 44px. A long multiline title may need more height. |
| Weekly hierarchy and interaction | Exact `gymSquareChip` Settings logos, bounded time/class/instructor grid, attendees indented on second row, shared spot circles, no dotted separator. Normal local rows 69–70px; started/completed 44–45px with tick/collapse. 320px long-name test caught and corrected an intrinsic instructor-width overflow. Whole row/attendee/blank-area activation; horizontal drags ignored; primary native button gives keyboard Enter/Space. No nested interactive controls. Selection and expansion survive repaint. |
| Team page scroll jump | Browser proved day-strip `scrollIntoView` moved the main scrollport from 0 to 46.5px. Replaced with strip-only horizontal scrolling; deployed Team breadcrumb is visible at page top. |
| Class page | Reuses `mountBookingCard`, strips its management rail/footer and obtains actions from the exact timetable event. Actual local browser matched Book, Edit, Join Waitlist and Auto-Book. Safe missing-event `Open timetable` link scopes gym/day. Team-member rows show only projected members/status/spot; queued status is Auto-Book. Captain or teammate data never creates a viewer booking action. Disabled gym action closes the page before Settings. |
| Manage and members | Captain order Join requests → My sharing → Members → Team settings → Leave/delete. Measured 24px gap after requests. Removed Captain explanation. Five total members inline; six total members replace all inline rows with one View all button and a dedicated Teams page. Browser preview: 0 inline + 6 full-list rows; unit tests assert viewer-inclusive threshold, Captain controls and read-only regular-member page. Requests do not count as members. Underlying server guards unchanged. |
| Spot/attendee fades and Edit | State computed from each scrollport, updated on content/resize/scroll with cleanup. Chrome fitting/start/middle/end: no fade/right/both/left. Edit mask none, actual `::after` divider display none, overflow-y hidden. Bookings Edit rail survived app-data-refreshed. |
| About and nav | Welcome tour first, concise app purpose, credential/account/delete explanation, Account destination; no emoji/feature catalogue. New two-head shared-shoulder nav glyph visually inspected beside neighbours. Deployed mobile Piers/PW identity is preserved; desktop Settings retained. |
| Prior requested behavior | Preserved Captain top-right/wider names, referee creation mascot, timezone-aware unfinished-class sleep, quiet glass/shadow, zero-done suppression, hidden Classes together, compact Home cards/finder ordering/confirmed-booking gate/future Next up, in-class count/avatars and member pill, exact sharing intro and All/Choose reveal, team route retain/retap/back, persistent action rails and horizontal spots, header shadow/mobile timetable/Bookings spacing. Existing unit suites cover these; this pass did not independently replay every earlier fixture. |

### Verification output and evidence

- Node `v22.23.4` `npm test` **exit 0**: `120/120 server suites passed`; `Test Files 117 passed (117)`; `Tests 958 passed (958)`. The earlier run failed on an unguarded optional ResizeObserver in jsdom; fixed before this successful full run.
- Final navigation adjustment was followed by client-only verification: `117 passed`, `958 passed`, exit 0. No server source changed in this revision.
- `npm run build:client` **exit 0**, `built in 1.79s`, with the existing >500kB chunk warning. `git diff --check` exit 0.
- Chrome screenshots/data: [development-revision evidence](../QA/browser-runs/teams-ux-2026-11-07/development-revision/). Includes before-current, restored Today/class/manage/About, six-member preview, narrow/dark/desktop, edge-state JSON, route matrices, back/forward and deployed smoke/asset identity. Local clock/long-name/member-count previews were DOM-only fixtures; no server writes.

### Deployment and remaining limits

Safe staging directory `/tmp/dibs-teams-revision.VizxtU` shipped through `./deploy.sh --experiment`; omitted `.env*`, databases/data, dependencies, QA captures and local fixture seed/generator tools. Compose output: experiment Up, unchanged `100.86.226.52:3006->3000`. Image `sha256:f9c2244b14e728578919381e3d7d5cb46e02a18be47246425f8536288f42de22`; ARM64; Node `v22.23.4`; restart count 0; pre/post writable diff only `A /data`. Public and tailnet `/api/health` HTTP 200/status ok. Tailnet-served JS `index-CmhfhiX_.js`, CSS `index-C7Wj0Qfu.css` and Teams chunk `teams-dashboard-neEhC618.js` match the final local build by SHA-256. Public asset fetches require authenticated Cloudflare Access; initial unauthenticated comparisons were login HTML and were discarded. Registry and Server Management CHANGELOG updated in this turn.

Remaining implementation: canonical teammate seat-map overlays are still unavailable because the privacy projection supplies display labels, not canonical slot IDs; no ambiguous label mapping was added. Remaining acceptance: physical iOS/PWA behavior and animation feel; full browser replay of waitlist-only Home, insufficient-credit and disabled-gym variants (the shared decision model/unit coverage remains). Seven-day weekly data starts today, so previous-calendar-day selection is not offered by the current model; completed/started current-day behavior is verified. These are limits, not blanket completion claims.

## UX revision implementation — 2026-11-07

Baseline reproduced in a new real Chrome CDP tab at 402×874: Settings → About → Home left hidden Settings `show-pane`, matched the global `:has()` selector and gave Home `padding-top:0px`. Current source also confirms the shared workout grid, favourite-card class page without members, six-plus inline membership, and unconditional two-sided masks. Evidence: `QA/browser-runs/teams-ux-2026-11-07/development-revision/before-current.png`. Vite had stopped; restarted the local client and cleared service worker/CacheStorage/IndexedDB before this reproduction. Design acceptance follows `TEAMS-UX-REVISION-2026-11-07.md`.

## Experimental redeploy — 2026-11-07 02:45 GMT

The current uncommitted `teams` worktree (base commit `62a620c`) was deployed to `sweatassistant-experiment` with `./deploy.sh --experiment`. No commit or push was made. The staged artifact excluded local QA browser screenshots and the fixture seed/generator scripts; the deploy script excluded `.env*`, `data/`, database files, dependencies, and the dev/prod compose files. The existing experiment database and exposure were preserved; the tailnet bind remains `100.86.226.52:3006->3000`.

Post-deploy, the container was Up with zero restarts on Node `v22.23.4`; `docker diff` showed only the bind-mounted `A /data`. Public and tailnet `/api/health` both returned HTTP 200 with `status: ok`. The served main JS, CSS, and Teams dashboard chunk SHA-256 matched the local build. Signed-in Chrome at `https://sweat-experiment.wingfield.tech/teams` showed the My Teams list, Captain badges, and next-class cards; screenshot: `Documentation/QA/browser-runs/teams-ux-2026-11-07/experiment-deployed.png`.

Verification this turn: Node 22 test output reported 120/120 server suites and 952/952 client tests passed; the wrapper then exited 1 because zsh's reserved `status` variable prevented exit-code capture, so the direct `npm test` exit code was not recorded. `npm run build:client` exited 0 (existing large-chunk warning). `git diff --check` passed after removing one whitespace-only line. This is not full acceptance: the previously listed waitlist-only, class-action, light/dark, and physical iOS/PWA checks remain open.

## In one minute

- Teams is built end to end: create, invite, approve, dashboard, stats, timetable chips, Home card and push alerts.
- A security audit was done and merged into `teams`. Its fixes ship with Teams.
- The experiment twin has realistic demo data so you can check it on your phone.
- Next step is your phone check, then your go-ahead to merge to `master` and deploy to prod.

## Phases

| ID | What it is | State | Key commits |
|---|---|---|---|
| T-0 | Design: mock-ups, three rounds, approved 2026-11-04 | Done | `51d6ea4`, `85cdf60`, `0b83d39` |
| T-B | Background booking sync for every account, so Teams data stays fresh | Built | `54d8e0d`, `5631ced` |
| T-1 | Membership core: create, invite link, requests, Captains, Manage page, names, onboarding, landing page | Built | `0e7c0d8`, `be9b6e1`, `8c2f441`, `4e7432f` |
| T-2 | Privacy projection (what each viewer may see) and the Teams list with mascot | Built | `1e23102`, `559e060` |
| T-3 | Team dashboard: today's workouts, this week, classes together, members | Built | `7c9801b` |
| T-4 | Team stats: week on last week, streak, busiest days and times, gym mix | Built | `466f360`, `12995a6` |
| T-5 | Reach: timetable Team chips, Home widget, three push types | Built | `347440b`, `359c47e` |
| T-5b | Push alerts opt-in per Team (default off) | Built | `a38babc` |
| T-6 | Later ideas: profile photos, Book next to, Moments, nicknames | Backlogged by you, 2026-11-06 | n/a |
| T-7 | Your 2026-11-06 decisions: same-class spot numbers, weekly Team goal, Home card order, abuse limits | Built | `68bb291`, `cf01b0e` |
| T8 | Mobile nav: mascot Home and two-mascot Teams icons; Auto-Book moved into a Bookings bar | Built | `f94b130` |
| T9 | Teams empty-state pitch, My Teams cards, matching Home card | Built | `129b9dc` |
| T10 | Shared Team avatar (mascot orb with emoji badge) and guided Create-a-Team flow with share sheet | Built | `20e1935` |
| T11 | Team page redesign | Built | `27a3ef8` |
| T12 | Team settings and sharing page polish | Built | `05d289c` |

T8 to T12 came from the mobile review rounds on the experiment twin. They are not yet listed in the PLAN phase table; the PLAN handover carries T10 only.

### Review fixes per phase

| Phase | What review caught and fixed | Commit |
|---|---|---|
| T-3 | A per-member "other gym" flag could leak that someone uses a gym you haven't linked; a freshness leak of the same kind | `9118075` |
| T-4 | Streak now counts only gyms the viewer has linked (a small Team could otherwise date a teammate's visits); daylight-saving fix for "same moment last week" | `23e3180` |
| T-5 | Stale re-imports of a known booking re-sent a push; Team chips persisted after logout; an N+1 query | `ea62dd6` |
| T-7 | Forced syncs past the limit were dropped; now 6 per user and gym per 10 minutes, with one trailing catch-up sync | `cf01b0e` |
| Fixtures | Only passwordless rows adopted, owner email option, declined joins skipped | `425e2fb` |
| Mobile rounds | Auto-Book Back target, invalid typed emoji, double-Enter save | `ed62c04` |

## Your decisions, 2026-11-06 to 07

| Decision | Result |
|---|---|
| Spot numbers | Shared only with people booked, waitlisted or queued for the same class (D13) |
| Friendly competition | A Team weekly goal (1 to 224 classes), set by a Captain. No leaderboard |
| Home Teams card | Kept when you have no Team, but placed last |
| T-6 | Backlogged |
| Security recommendations | Handled by a separate agent (below) |
| Surname | Teammates see a one-letter surname initial, never the surname (D12 amended) |

## Screenshots (best per phase, 390 px light)

| Phase | Screen |
|---|---|
| T-2 Teams list | [t2-list](teams-mockups/screens/t2-list-390-light.png) |
| T-3 Dashboard | [t3-dashboard](teams-mockups/screens/t3-dashboard-390-light.png) |
| T-4 Stats | [t4-stats](teams-mockups/screens/t4-stats-390-light.png), [gym mix](teams-mockups/screens/t4-stats-390-light-gym-mix.png) |
| T-5 Timetable chips | [t5-chips](teams-mockups/screens/t5-timetable-chips-390-light.png), [Home](teams-mockups/screens/t5-home-teams-390-light.png) |
| T-5b Alerts switch | [manage on](teams-mockups/screens/t5b-cap-390-light-2manage-on.png) |
| T-7 Team goal | [goal set](teams-mockups/screens/t7-goal-captain-set-390-light.png) |
| T8 Bookings bar | [bookings](teams-mockups/screens/t8-after-390-light-bookings.png) |
| T9 Empty state | [empty](teams-mockups/screens/t9-after-empty-390-light.png), [list](teams-mockups/screens/t9-after-list-390-light.png) |
| T10 Create flow | [name](teams-mockups/screens/t10-create-name-390-light.png), [ready](teams-mockups/screens/t10-create-ready-390-light.png) |
| T11 Team page | [team](teams-mockups/screens/t11-after-team-390-light.png) |
| T12 Settings | [captain settings](teams-mockups/screens/t12-after-captain-settings-390-light.png), [sharing page](teams-mockups/screens/t12-after-sharing-page-top-390-light.png) |

## Security audit

Branch `security-audit` (5 commits ahead of `master`, tip `fe3ce33`), merged into `teams` at `e86eff6`.

| Fix | Commit |
|---|---|
| Shared HTML escaper and a safe-link check for provider URLs | `1d8e804` |
| Security headers and an enforced content security policy (inline scripts hashed) | `1ff6987` |
| Logins can be revoked (`users.token_version`) | `2cf06ba` |
| Gym sessions encrypted at rest (AES-GCM, tied to user and gym) | `2cf06ba` |
| Single-use 60-second tickets for live updates (max 10 per user) | `2cf06ba` |
| Admin secret derived separately; constant-time dummy check for unknown emails; calendar lone-CR fix; landing analytics uses `req.ip` | `2cf06ba` |
| Backups go to an encrypted remote by default | `fe3ce33` |

Review of the audit caught four problems, all fixed in `ba9a451`:

| Severity | Problem |
|---|---|
| High | A missing `ENCRYPTION_KEY` exit would have crash-looped prod; it now warns |
| Medium | Constant encryption context; now bound to user and gym |
| Medium | Live-update tickets could be flooded; now capped per user |
| Low | Sealing at boot could crash; now non-fatal |

The older live-update `?token=` path is still present and is due for removal next release. Prod needs the security deploy checklist in AGENTS.md before deploying.

## Oracle backups

- Nightly SQLite backup now uploads to an encrypted rclone remote (`gdrive_crypt`, Drive folder `Backups/oracle-crypt`). A restore test passed.
- The old plaintext Drive folders were permanently deleted: `Backups/sweatassistant-sqlite`, `Backups/psycle-sqlite` and `Backups/oracle`. The last held a configs archive containing service `.env` files.
- **Exposure:** prod's `ENCRYPTION_KEY` and `JWT_SECRET` were in that archive. You chose not to rotate for now. This remains an open risk.

## Experiment twin

`sweat-experiment.wingfield.tech`: behind Access, database a copy of dev's from 2026-10-12, never prod data.

| Item | Detail |
|---|---|
| First deploy | `00f055d` (Teams plus security) |
| Latest deploy | `ed62c04` (does not yet include the surname initial) |
| Backups before deploys | `data/pre-teams-security-20261106-1755.db`, `data/pre-fixtures-20261106-2258.db` |
| Rollback | Redeploy the previous commit and restore the matching backup |

**Demo data** (`71d874e`, `425e2fb`): fixture accounts (`users.is_fixture`) never reach a gym, cannot log in, are skipped by every background job and carry an admin badge. `server/scripts/seed-team-fixtures.js` (options `--dry-run`, `--remove`, `--owner-email`) seeded 7 fixtures, 4 new members of "Lesbian Wednesdays" (one hidden), 2 pending requests, and a second Team, "Burpee Brunch Club", where you are an ordinary member. Undo with `docker exec sweatassistant-experiment node server/scripts/seed-team-fixtures.js --remove`.

## Tests

| Point | Server suites | Client tests |
|---|---|---|
| `ed62c04` | 119 of 119 pass | 950 of 950 pass |
| After the surname-initial letter fix (2026-11-07) | 120 of 120 pass (one known timing flake, `test-poller-backoff.js`, did not trip this run) | 950 of 950 pass |

## Known deviations

- The timetable Team chip still shows the emoji beside the name (no room for the avatar).
- Page titles are now centred on every full-screen page app-wide; pages outside Teams were not browser-checked.
- The sharing page "Save" only closes the page, because changes already save immediately.
- Notification copy for non-Captains omits join requests.
- Screens before T-7 used mock gyms only; no real gym account was touched.

## Open and next

1. **Your phone check** of the experiment twin.
2. Redeploy the experiment twin with the surname initial.
3. Measure background gym-call volume on the experiment twin (the T-B exit criterion).
4. Merge `teams` into `master`, then deploy to prod. Needs your go-ahead, and the security checklist.
5. Secret rotation: declined for now, see Oracle backups.
6. Remove the legacy live-update `?token=` path next release.
7. T-6 stays backlogged.

**Incident note:** on 2026-11-06 at about 22:xx an agent killed an unrelated local `node server.js` on port 3000. Nothing in the repo was affected; agents are now told not to kill processes they did not start.

## 2026-11-07 — Teams and app UX refinement (in progress)

**Latest design handoff (2026-11-07):** [Teams UX revision and acceptance brief](TEAMS-UX-REVISION-2026-11-07.md) records the owner's latest corrections, targeted source/history checks and real-Chrome experimental baseline. It supersedes the previous Today/About presentation where specified. This design pass changed no application implementation; development and experimental redeploy remain pending.

Local-only work on `teams`; no push or deployment. Baseline verified in the user's Chrome through CDP :9222, isolated localhost:5173 + localhost:3000 and `/tmp/dibs-teams-ux.db` (mock accounts only). Screens: `Documentation/QA/browser-runs/teams-ux-2026-11-07/before-list.png` and `before-team.png`.

Confirmed causes before edits: list identity reserves 36px and wraps Captain in the member metadata; workout renderers use different layouts with no completed expansion/action handling; zero-done header is unconditional; sleep takes priority at viewer night even with unfinished Eastern classes; Home uses full list metadata; sharing always paints gym cards and descriptions; navigation explicitly routes Teams back to list; background list replacement loses open card action rails. About retains old feature copy and emoji icons.

Checklist (all pending until same-session checks):
- [ ] Realistic mock teammate timetable/spotmap overlap, timezone coverage and safe fixture isolation.
- [ ] Teams list identity, referee creation guide, Teams nav icon, liquid-glass mascot and correct sleep.
- [ ] Shared today/week workout hierarchy, instructor, small gym, spot circles and horizontal attendees; started/completed animated expansion; safe timetable actions; hide Classes together.
- [ ] Team hero count/avatar line, zero-done hiding and Members hierarchy.
- [ ] Home finder above Teams and hidden with confirmed bookings; compact Teams and future Next up.
- [ ] Sharing copy, conditional animated gym picker, simpler rows and no dotted goal separator.
- [ ] Teams return/detail state and animated breadcrumb; persistent Bookings/Auto-Book action rails across refresh.
- [ ] App edge fades, header shadow, timetable spacing, quick-gym border, edit divider, bookings spacing.
- [ ] Account identity nav, Settings padding/scroll and current About.
- [ ] Full test/build plus real Chrome mobile/desktop light/dark verification; evidence recorded.

### 2026-11-07 UX continuation and verification

The previous development agent's local UX edits and fixture work were retained. The continuation corrected the Home class finder to recognize confirmed bookings with `event.start_at`, fixed class-sheet test mock isolation, and applied the subsequent mobile-only navigation correction: desktop keeps Settings and a settings icon; mobile uses the first name and initials. The fixture server was restarted against the isolated `/tmp/dibs-teams-ux.db` so server-side mascot changes were loaded. No deployment or live gym writes were performed.

Checklist status: **implemented locally, with browser verification still incomplete**. Existing code and tests cover the Teams list sizing/Captain placement, referee asset, Teams icon, timezone-aware sleep, glass and shadows, Today/This week workout hierarchy, collapsible started rows, class sheet, hidden Classes together, compact in-class line and member pill, Home finder and compact Team cards, sharing copy and picker, Teams navigation retention, booking/auto-book rails, and the requested general app and Settings styling. The Chrome check on the current local app confirmed the list/Captain placement, desktop Settings label, iPhone 16 Pro emulation's name and initials, an upcoming class sheet with Quick book and choose-a-spot and dismissal, expansion of a completed class, and a non-sleeping mascot while future classes remain. Server tests cover Eastern time including a DST boundary and privacy projections for unlinked gyms. The exact sharing intro and Number of classes label are present in the implementation.

Still requires real-browser acceptance before treating the whole checklist as complete: verify every class-action state (including waitlist and auto-book), Home finder with confirmed-booking and waitlist-only fixtures, individual sharing picker transitions and privacy visibility, nav retap/breadcrumb animation, creation mascot, rail refresh/scroll behavior, light and dark appearance, responsive overflow, settings safe-area scrolling and About, and real iOS/PWA behavior. Mock bookings persisted from an earlier date may not accurately reproduce current owner booking state; refresh the isolated mock fixture before relying on that scenario. The current browser test did not submit booking or sharing changes.

Verification at this checkpoint: Node 22 `npm test` exited 0 with 120/120 server suites and 952/952 client tests before the final mobile-only navigation adjustment. `npm run build:client` exited 0 after that adjustment, with Vite's chunk-size warning. A final full suite was started after the adjustment; its result should be recorded when complete. Before/draft browser images are in `Documentation/QA/browser-runs/teams-ux-2026-11-07/`.

Final Node 22 `npm test` after the navigation correction exited 0: 120/120 server suites and 952/952 client tests. The mobile Chrome sharing sheet showed the specified intro and Number of classes, hid gym options in All my gyms mode, and revealed the three linked gyms under Choose; the isolated fixture was returned to All my gyms. Accessibility state confirmed the two modes, but smoothness of the transition needs visual review. Further Chrome acceptance was interrupted by inconsistent native automation window/element availability; no claim is made for unchecked flows listed above.

Subsequent CDP acceptance and mock fixture repair: the previous stale mock bookings were replaced **only in an isolated `/tmp` mock file**, then the network-forbidden seed was rerun. It reported 7 fixture accounts, 20 teammate bookings, 2 waitlists, 2 queued classes and 3 overlapping owner classes. For a repeatable local demo use `dev@psycle.com` at `http://localhost:5173/` (development mock password: any value); with the isolated dev environment already configured, set `MOCK_BOOKINGS_PATH` to a **new absolute disposable path**, run `node server/scripts/create-teams-mock-bookings.js`, start the local server with that same path, and run `node server/scripts/seed-team-fixtures.js --mock-timetable --owner-email dev@psycle.com`. The generator requires `NODE_ENV=development`, refuses to overwrite an existing path, and blocks outbound fetch while generating. The seed verifies that all owner gym sessions are mocks and blocks outbound fetch. A fresh account needs an owner Team created before seeding.

With the repaired fixture, Chrome showed 3 upcoming bookings and hid Find a class; before repair, with no current bookings, it showed Find a class above Your Teams. Timetable displayed 6 teammate chips, including expandable Team/member details. The Bookings rail stayed open after an `app-data-refreshed` booking refresh and its next-day editor opened a 40-spot map. Account was scrolled into view above the mobile bottom navigation (bottom 701px versus navigation top 818px at 402×874). Screens: `after-booking-editor.png`, `after-settings-bottom.png`, and `after-timetable-chip.png` in the browser-run directory. The generator passed `node --check`, created 3 current entries, and refused a production invocation (exit 1; no target file created).

Spot-map teammate overlays are **not implemented or verified**. The privacy-filtered Team data contains shared spot labels but no canonical slot ID; matching arbitrary labels across studio layouts is not yet proven safe. The timetable Team chips are the currently demonstrated teammate indicator. The browser session did not establish an opt-in spot text case; automated privacy tests cover the same-class and opt-in boundaries. Other acceptance gaps in the previous paragraph remain, including waitlist-only Home behavior and physical iOS/PWA checks.

Final acceptance continuation: Chrome at 402×874 restored the Team detail after leaving and returning, and the second Teams tap returned to the list. Both Bookings and Auto-Book action rails remained open after a refresh; the Auto-Book check used a temporary queue row in the isolated DB, then deleted it (1 row). The Bookings spot container computed `overflow-x: auto` and `overflow-y: hidden`; a many-spot physical swipe was not exercised. Sharing mode was changed to Choose, showed three gyms, restored to All, saved, and reopened with All selected. The Home widget regression checks confirm the finder depends on confirmed bookings and does not consult waitlists; a waitlist-only browser fixture was not created. The earlier started-class check expanded a completed row; the Eastern unfinished-class/DST server test passed as part of 13/13 projection checks. The mobile Home showed a Next up class and the test suite covers tomorrow's hint.

After the full-suite run, the isolated mock generator was added and a Home regression assertion was extended. `node --check server/scripts/create-teams-mock-bookings.js` passed, its local generation and production guard were exercised, and the focused Home/Teams tests passed 68/68 across 3 files. No git commit was made. The broad suite result above predates only these generator/test additions and a comment correction. Remaining implementation: teammate seat overlays in spot maps (the timetable alternative is present). Remaining acceptance: physical iOS/PWA, waitlist-only browser fixture, actual many-spot horizontal swipe, other class action states (waitlist/auto-book), animation smoothness and full light/dark visual sweep; these are not claimed as passed.

### 2026-11-07 — Today, Week disclosure and instructor trends refinement

Baseline evidence: real Chrome CDP at localhost:5173/teams/kTgaoxLgF6G0PMbH (402px), screenshot `/tmp/teams-refinements-before.png`. Today completed labels contained location text; renderThisWeek initialized an automatic selection and rendered rows immediately; renderTeamPage placed stats after Members. Server team-stats input lacked instructor identity. These source paths and browser DOM/screenshot confirmed the requested basis before implementation.

Changed Today to a stable logo/time/class grid, instructor labels and full spot-label capsules. Week now begins with no selected day, exposes an explicit choose-day hint, and preserves only an explicit selection across repaints. Stats moved above Members. Trending instructors compares equal rolling 14-day windows of existing itemised-visible shared class visits; positive growth and two current visits are required. Gym-qualified instructor identity comes through the existing server projection; metadata supplies photos only, with initials for missing/failed images. No raw provider calls or client activity reconstruction. Verification and deployment evidence follows below.

Verification: Node 22.23.4 `npm test` returned 120/120 server suites and 117 client files / 959 tests passed. After metadata photo hydration, all 959 client tests passed again; the final focused dashboard suite passed 15/15. Trend units passed 11/11 and real-DB privacy passed 59/59. Production client build passed (existing Vite warnings). Real Chrome verified initial Week zero rows/selection/See more, explicit disclosure, stats before Members, and the 320px New York suffix fixture: both time columns x=67,width=40, ET centered underneath, gym logos present, zero overflow. Mock metadata has no photos; cached-photo rendering/error fallback is covered in units. Native keyboard dispatch cannot activate the hidden Chrome tab while the desktop is locked; physical iOS remains unverified. Evidence: [dashboard refinement report](../QA/browser-runs/teams-refinements-2026-11-07/REPORT.md).

Dev deployment preflight: existing dev container Up, 100.86.226.52:3005→3000 unchanged, docker diff only A /data. WAL-safe backup `/data/pre-teams-dev-20261107-1794055039550.db`, integrity_check ok. User authorized commit/push of the Teams work and deployment to dev; production and experiment are outside this deployment. Deliberate commit scope includes the previous UX revision and this refinement, runtime referee WebP, edge-fade helper/tests, mock fixture utilities and concise QA evidence; large untracked source character PNGs and previous bulk QA captures remain local.

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
