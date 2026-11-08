# Sol design implementation — 7 November 2026

Scope: [approved design brief](../../../Workstreams/TEAMS-ONBOARDING-DESIGN-2026-11-07.md), following the [before receipt](../sol-design-sweep-2026-11-07/README.md). Sole development agent; Gemini Flash used for four bulk locator/review calls. Exact source and real Chrome independently checked; a Gemini diff claim about a missing name-save selector was rejected because the actual footer and passing interaction tests contain it.

## Before / after evidence

The developer refreshed the baseline in one owned tab in the user's actual Chrome at CDP 9222 before application edits. Current baseline: Homerun implicitly selected, 44px visible credential fields, one decorative cloned logo set, 24s infinite animation. Back/add-another replaced the strip (`sameStrip=false`, old node disconnected, new animation time=0). This proves a render-driven restart; a separate image-decoder/GPU defect was not reproduced. Team focus left Ideas visible. Name and feature copy matched the earlier design receipt.

| Requested surface | Implemented and checked |
|---|---|
| Welcome / all steps | Five glass feature widgets; centered semantic page titles, actual shared Team orb at 96px (80px short), 14px speech, no left-tail artifact. [Welcome](welcome-390.png). |
| Studios / motion | Five original wordmarks at 140×52; no clone or Pause button. Decode before one 4.5s discovery scroll; interaction stops it, manual touch/arrow scrolling remains. Same strip node survives in-step Back/add-another; no animation reset. Reduced motion stays static. |
| Explicit gym choice | Empty chooser and hidden grouped credentials; selecting a gym reveals the form. Exact requested body copy. Glass secondary connection action and contrasting 44px+ continue control. No credential/API behavior changed. |
| Name provenance | Actual stored gym profile fields feed existing inference. Alpha/Alex fixture produced “Can I call you Alex?” and exact requested body; saved Robin produced generic question with no gym-origin claim. Both inputs editable; account save retained. [Name](name-profile-390.png). |
| Make it yours | Four widgets only; exact short bubble; reserved right status, persisted success check, collapse/reopen. [Light](features-390-light.png), [dark](features-390-dark.png), [short-screen end](features-end-320.png). |
| Auto-Upgrade | Native switch, initially off. Real Space key: checked/pending/disabled, no tick and finish disabled; resolving three scoped saves produces collapsed success. Failure/partial failure rolls switch back and permits retry. No initial-setting writes. |
| Completion | Exact “Continue to Dibs”, double-tap guarded. 240ms exit; 300ms fallback prevents a frozen background animation timeline trapping the flow. After awaiting actual completion: path `/`, onboarding display `none`, active element H1 “Good evening, Alex!”. Reduced motion completes without travel. |
| Calendar | Explicit onboarding context, four spaced cards, one-way feed explanation, Done. Enabled setup has zero Refresh/Turn off; Settings retains both. Context survives renderer refresh. [Calendar](calendar-390.png). |
| Team keyboard | Focus hides Ideas; restores after blur settles; 84px orb remains visible. At 390×430: header bottom 60, orb top 186.7, button bottom 418, viewport 430 (12px gap). [Keyboard layout](team-name-430.png). **Viewport simulation, not physical iOS keyboard proof.** |
| Team week | First tap aria-expanded true; second false; details and See more close, hint returns, focus remains on tapped day. Reopen starts compact. Regression test fails with the former always-select implementation. |
| Trending / nav | Visible 14-day comparison/“was” removed; accessible chart description retains actual previous/current/delta. No calculation/window/privacy change; Home retains its distinct 30-day metric. Trophy SVG keeps Teams label/route. |
| About | Tour first, distinct purpose second, private-data panel third. Correct server decryption and deletion/backups qualification retained. [About](about-390.png). No legal routes published. |
| Home inner cards | Shared tint/highlight/rim/shadow for favourites, credits, activity and instructor cards, with no extra nested blur. [Activity/instructors](home-tiles-390.png). Existing counts, charts, swipe and identities preserved. |
| Settings / auth / spots | Only active pane gets 14px top gap; hidden panes remain hidden. Dedicated softer placeholder token: sampled field contrast 4.65 light / 4.59 dark. Shared editor hint→Clear measures 18px, button 44px. |
| Link preview question | No new image or Open Graph publication; generic private-invite behavior preserved. Optional future generic brand card remains a separate choice. |

Screenshots document the visual pass; later finish-focus/spacing/catalog changes were verified with the actual browser measurements above. No physical device, gym booking/cancel/purchase, real push test, production account mutation or legal publication was used.

## Checks

```text
Full npm test server phase: 121/121 server suites PASSED.
Initial client phase: 974/975; copy-catalog audit found new fixed textContent strings.
Corrected strings moved into COPY; final npm run test:client:
  Test Files 120 passed (120)
  Tests      976 passed (976)
Client build: 128 modules transformed; built successfully (existing Vite mixed-import/large-chunk warnings).
Brand invariant: PASS no hardcoded product name in 215 app files.
git diff --check: no output, exit 0.
```

Real Chrome matrix: 320×568 light, 390×844 dark, 1280×900 light, reduced motion/transparency. Welcome/studios/features/About/Home: no horizontal document overflow; all actions reachable by natural scroll on short screens. Normal logo discovery moved 0→29px (320) / 0→24px (390) during the sample; reduced motion 0→0. Completed rows and focused Team-name layout were checked separately. SW registrations, CacheStorage and IndexedDB were cleared before the after pass; real reload followed. Chrome snapshots do not establish physical iOS behavior or live gym API behavior.

## Release

Immutable production-only source `4e92430317b50939943c13ae3cb3f12299b89eae` is deployed and pushed to `origin/teams` (unmerged into `master`). Landing source unchanged. [Real production welcome](production-welcome-390.png) shows the new centered title, 96px orb, 14px bubble and five feature widgets; loaded asset names match the release. Preflight confirms Node 22.23.4, no host bindings, writable layer only `/data`. On-demand WAL-safe backup: integrity `ok`, encrypted prod/dev uploads succeeded. Additional rollback DB/env/compose/image and pre-release counts captured at `/home/ubuntu/services/sweatassistant/rollback-sol-design-20261107`; current counts are 2 users, 2 links, 1 Team, 1 member, zero auto-book/upgrade/push rows. Previous DEPLOYED_COMMIT file was stale (`c98ef9a`), while actual source SHA-256 and served assets matched `ce67ae2`; the new release now stamps its exact source commit.


Live verification output:

```text
.env: OK; compose unchanged
PRAGMA integrity_check: ok
counts before == after: users2, links2, teams1, members1, autobook0, autoupgrade0, push0
sweatassistant | Up | 3000/tcp
restarts=0 bindings={}; v22.23.4; arch=arm64
internal health HTTP200; public health HTTP200 status=ok
scheduler/poller/calendar healthy=true
DEPLOYED_COMMIT=4e92430317b50939943c13ae3cb3f12299b89eae
container onboarding source matches verified commit
/terms HTTP404; /privacy HTTP404; /sw.js cache-control:no-cache
```

Container and public JS/CSS match the checked local build:

- `index-B1ZgysMW.js`: `36eb0a9c20fddef4fc66807ca14283a8839852ccbebb231bb04d68e77c6a6e54`.
- `index-DrnTJXwJ.css`: `9b5131248abe7740b14d661180c349957b3160e5b080ad48d7011a22dc5fb8c5`.

Public urllib probe received HTTP403; normal curl and the real Chrome public load succeeded (HTTP200, exact shell/asset checks). No Cloudflare policy was changed. A 200% text enlargement simulation at 1280×900 retained zero horizontal overflow; at the natural scroll end both public auth actions were within the viewport. This is a text/layout simulation, not a physical-device or browser-zoom claim. Existing dev/experiment/landing were not redeployed. The infrastructure registry and host changelog were updated in the same release turn. Unrelated untracked art and older QA captures remain untouched.
