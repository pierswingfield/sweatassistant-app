# Teams: progress report

**As of 2026-11-07.** Branch `teams` (58 commits ahead of `master`, latest the surname-initial work after `6fedd1a`). Nothing is pushed to `master` or deployed to prod. The experiment twin is running an earlier build.

Full design and decisions: [PLAN-teams.md](PLAN-teams.md). Screenshots are linked below (open them from the repo).

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
