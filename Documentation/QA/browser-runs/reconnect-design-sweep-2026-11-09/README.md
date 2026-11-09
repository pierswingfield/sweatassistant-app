# Reconnect design sweep — experiment, 9 November 2026

Final source remains uncommitted on `feat/optional-gym-login-policy` in `App-teams`, based on `43592eb`. Experiment only was deployed. Production, dev, marketing, DNS and Access configuration were not changed. No push, merge, account reset, provider booking/cancellation/purchase, session corruption or notification send was performed.

## Result and design

Home’s reconnect state is a registered `connections` widget, placed first in the existing left column on desktop and first in the mobile reading order. It uses the same `.home-widget`, heading, surface, border, radius, shadow and spacing as the current Home components. Gym mark/name/status rows have distinct accessible reconnect actions. The separate orange warning banner and long instructions are removed. One, multiple and all-unavailable cases retain the action; a syncing connection shows a brief status rather than requesting another login.

When a link needs login, its Settings pane renders only Connection, with the concise **Login needed** status and reconnect/unlink controls. The added paused/queue-count/bookings/calendar paragraph is removed entirely. Gym-owned settings are retained and return on recovery. Unavailable panes skip membership/credit/settings reads that are irrelevant or gated during reconnect. Healthy settings retain their normal cards. At 320px the session label occupies its own row rather than being truncated between actions.

The gym-login submit now follows the Remember disclosure in normal scrolling flow on mobile. The shared `modal-nav.js` viewport shell, focus/navigation behavior and other modal action layouts remain intact. There is no keyboard-attached action or additional viewport offset. Input labels are associated with the actual email/password inputs. Existing body safe-area padding remains in effect.

## Verified basis

- [Before Home](before-home-mobile.png): custom orange border and dense instructions above the ordinary Home cards.
- [Before unavailable Settings](before-settings-needs-login.png), [measured result](before-settings-needs-login.json): **6 cards**, exact noisy calendar paragraph present. The first generic before check targeted healthy Aarmy; the explicit Psycle check establishes the actual unavailable-state evidence.
- [Before focused 390×420 form](before-reauth-small-viewport.png): sticky Re-authenticate overlays the Remember disclosure. [Before checks](before-output.txt) record its computed `sticky` positioning.
- The regression in [settings-red.txt](settings-red.txt) first failed because six cards were rendered where one was required. The shared submit was explicitly sticky inside the scrollable form; retaining the viewport shell and removing that one sticky action removes the overlap.

Test3’s existing real Chrome session was used for read-only deployed checks. At inspection Aarmy was healthy and Psycle needed login, superseding the prior receipt’s two-unavailable diagnostic state. Neither connection was deliberately altered. Multiple/all-unavailable and long names use isolated local UI fixtures, not induced live failures.

## Final checks — actual outputs

| Check | Final output | Evidence |
|---|---|---|
| Node22 `npm test` | **125/125 server suites passed; 124 client files / 996 tests passed** | [npm-test.txt](npm-test.txt) |
| Node22 production client build | **built in 1.01s**; existing import/chunk-size warnings | [build.txt](build.txt) |
| Real Chrome local UI checks | **28/28**, no page errors | [local-output.txt](local-output.txt), [checks](local-checks.json) |
| Real Chrome deployed checks after final recreate | **20/20**, no page errors | [experiment-output.txt](experiment-output.txt), [checks](experiment-checks.json) |
| Source/deployed artifacts | **357/357 host source/config, 347/347 runtime source, 15/15 built JS/CSS hashes match** | [final-hashes.json](final-hashes.json) |
| Public/internal health | **HTTP 200**, status ok; scheduler/poller/calendar healthy | [internal](remote-final-verify.txt), [public body](public-final-health.json), [headers](public-final-health-headers.txt) |
| SQLite integrity and preservation | **ok**; 12 users, 18 gym links, 2 Auto-Books, 2 Auto-Upgrades, 11 Team memberships, 3 Teams, same before/after | [before](database-before.txt), [final](database-final.txt) |
| Policies through Cloudflare | **200**, `no-cache, no-transform`, readable contact, no email-obfuscation markup | [policy-preservation.json](policy-preservation.json) |

Full checks were rerun after the final 320px visual refinement because source changed; unchanged source was not repeatedly retested for confidence. Initial fixture/harness failures are retained in `local-first-*`, `local-second-output.txt` and `local-before-small-screen-refinement.txt`. They exposed a compact-button sizing issue and a too-early close assertion; later fixture reads also needed to use Vite’s timestamped module identities. Final fixtures clear SW/CacheStorage/IndexedDB and use the actual dependency graph. Unrelated local fixture widgets can be unpopulated; the deployed screenshots show the actual signed-in Home. The original `/home` inspection URL was corrected to the application’s `/` Home route before evidence was taken.

## Screenshots inspected visually

| Scenario | Evidence |
|---|---|
| Final deployed Home, 390px light | [Home](experiment-home-mobile-light.png) |
| Final deployed Home, desktop dark | [Home desktop](experiment-home-desktop-dark.png) |
| All gyms unavailable, phone dark | [All unavailable fixture](home-all-mobile-dark.png) |
| Multiple long names, 320px, scroll to last login | [Long names](home-long-mobile-scroll-end.png) |
| Final deployed connection-only Settings, phone | [Settings light](experiment-settings-mobile-light.png) |
| Final deployed 320px Settings, dark | [Settings dark](experiment-settings-small-dark.png) |
| Focused reduced viewport, Remember visible | [Remember and policy links](experiment-reauth-small-remember.png) |
| Same reduced viewport, submit visible at scroll end | [Submit](experiment-reauth-small-submit.png) |
| Landscape and offset/height shell fixture | [Landscape](reauth-landscape-dark.png), [viewport check results](local-checks.json) |

The browser assertions cover no overlap, scroll reachability of checkbox/policies/submit, a 44px reconnect action, no horizontal overflow, named per-gym actions, connection-only initial rendering and reload, fixture recovery/repeated status transitions, landscape, modal close cleanup and one visual-viewport height/offset application. A reduced **desktop Chrome** viewport and a visualViewport fixture are **not a physical iPhone keyboard test**. Actual iPhone keyboard animation, browser accessory bar and physical safe-area behavior remain unverified. Focus email/password with the native keyboard open and scroll through Remember, both policy links and Re-authenticate as the focused physical follow-up.

## Deployment and rollback

`./deploy.sh --experiment --print` was reviewed before deploy; [preview](deploy-preview.txt). Both deployments completed through the normal full Dockerfile and existing build cache; no offline image patch, dependency/base change or remote pull workaround was needed this time. [Final deployment output](deploy-final.txt).

Final image **`sha256:179647fb1bc234496c7e145eebcff0e1af7c4553ca41d4607c1c206095cb9362`**, Linux ARM64, Node **v22.23.4**, **running / zero restarts**, unchanged **100.86.226.52:3006 → 3000** on `edge` and its project network. Docker writable diff contains only `/data`. Environment and compose compare byte-for-byte with the pre-deploy preservation copies. [Preservation](preservation-before.txt), [runtime](remote-final-verify.txt).

Rollback image: `sweatassistant-experiment:rollback-reconnect-design-20261109`. Host-only environment/compose/original image ID: `~/services/sweatassistant-experiment/rollback-reconnect-design-20261109/`. WAL-safe SQLite backup: `data/.rollback-reconnect-design-20261109/app.db`, file mode 600 inside a 700 directory. No secret values were copied into the receipt. Reconcile later forget-login/consent decisions before restoring any old database; see CURRENT.md’s existing procedure.

Gemini provenance: one Flash bulk locator call for project/design/testing/operations and deployment instructions, with exact source/instruction lines independently inspected. The diagnosing-bugs and selfhost-deploy skills supplied the red-capable feedback loop and preservation workflow. No development subagent was spawned. The single owned Chrome tab is closed after verification; temporary onboarding-complete browser state is restored.
