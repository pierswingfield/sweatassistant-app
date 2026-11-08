# Personal stats design baseline — 2026-11-08

Scope: baseline research and [implementation brief](../../../Workstreams/HOME-PERSONAL-STATS-ONBOARDING-2026-11-08.md). No app source implementation, deployment, host access, commit, push or merge occurred. Existing untracked assets were preserved.

## Browser evidence

Attached to the user's existing Google Chrome through CDP `127.0.0.1:9222`. Opened one owned tab at `http://localhost:5173/`; did not navigate or close pre-existing user tabs. The local app was already running and signed in to its dev fixture account. No gym booking, cancellation, payment, push subscription, calendar enablement or Auto-Upgrade setting was changed. Replayed existing welcome/setup UI only. Used raw CDP because the repository documents browser-context incompatibility with Playwright. Initial screenshot attempts lost their emulation when the CDP connection closed; final images were overwritten after applying 390×844 metrics on the same screenshot connection. Final PNG dimensions were checked. These are Chrome viewport simulations, not physical phone installation tests.

| Evidence | Observed baseline |
| --- | --- |
| [Welcome](welcome-baseline-390.png) | Heading `Welcome to Dibs`; bubble `Your boutique fitness concierge.` |
| [Gym connection](gyms-baseline-390.png) | Bubble `Bring your studios together.`; a single logo track with one set, scroll width 744px. Source moves once over 4.5 seconds using cosine easing. Chrome was background/locked at times; no continuous timing proof is claimed from a still image. |
| [Optional setup](setup-baseline-390.png) | Preferred maps still offer setup; Auto-Upgrade switch is unchecked and **disabled=false**. Saved-slot eligibility is not wired into this switch in the source. |
| [Home](home-baseline-390.png) | Upcoming favourites widget shows its no-matching-classes message; Your activity shows provider class totals and no requested personal charts; Find a class is present without the new empty-bookings text. |
| [Teams](teams-baseline-390.png) | Existing fixture account has three Teams; list cards render. Source initial load uses spinner. Zero-Team and throttled-load variants are not claimed as reproduced in this baseline. |
| [About](about-baseline-390.png) | Fixed referee image and the full backup/copies final clause. Browser text matched the inline card in `client/index.html:572`. |
| [Timetable](timetable-baseline-390.png) | Rightmost selected date visibly fades at the edge. One early computed-style sample was `mask: none`; a later sample showed `.app-wk-scroller.has-edge-fade.fade-right`. Shared observer/CSS source is the candidate to verify after it settles before changing. |

These are before screenshots. They do not establish any requested fix as implemented or passing. No post-change browser test is possible for documentation-only work. The separate implementation pass must test genuine zero-Team, zero-favourite and history-import cases with suitable local fixture setup.

## Source evidence checked directly

- `client/src/ui/onboarding.js`: welcome at 311, studio copy at 645, stable logo node at 657–659, optional setup/switch at 922–1053.
- `client/src/ui/gym-logo-strip.js`: finite 4.5-second eased discovery and stop-on-interaction behavior.
- `client/src/main.js:1957`: signup-success toast.
- `client/src/ui/teams.js:69–92`, `teams-pitch.js:13–34`, `copy.js:1108–1113`: spinner/list resolution, three existing pitch rows and copy.
- `client/index.html:560–574`, `teams-ui.js:52–68`: About source and valid local mascot mapping.
- `client/src/ui/home.js`: finder future-booking guard, provider-attendance stats, global favourites gap and existing mutation subscription.
- `client/src/ui/edge-fades.js` and `.has-edge-fade` in `client/src/styles.css:12863`: shared date-row edge-mask candidate. No generic fade removal is authorized.
- `server/class-history.js`: sync ownership, persistence, dedupe, six-hour staleness, fourteen-day overlap, counted statuses, all-time summary and failure preservation.
- `server/routes-normalized.js:326–331` and `758–789`: link/relink backfill and existing history endpoint limits.
- `server/poller.js:1374–1377`: history cron, distinct from upcoming booking sync.
- `server/providers/codexfit.js:1042–1073`, `marianatek.js:1320–1380`, and `gyms.config.js`: both protocols, normalized outcome coverage, page guards and five-gym adapter assignments.
- `server/db.js:2550–2559`: unlink removes live per-gym history; it is not retained indefinitely after unlink.
- `client/public/manifest.json`: scope, id and start_url `/`; standalone display.

## Research provenance and limits

Used the Gemini-offload skill: three successful Gemini Flash calls to locate documentation/UI source, one grounded call to locate PWA docs. One additional oversized bulk UI call failed with `Argument list too long`; retried as two smaller source calls. Flash's About-file location was incomplete; direct search located the actual inline HTML and exact final clause. All claims used in the brief were checked against owning source or primary web material; the model outputs alone were not accepted as evidence.

Primary pages verified on 2026-11-08:

- [Google PWA OS integration](https://web.dev/learn/pwa/os-integration): Android Chrome WebAPK scope routing and iOS/iPadOS absence of incoming URL capture.
- [Apple WWDC23 web apps](https://developer.apple.com/videos/play/wwdc2023/10120/): in-app scope and outside-scope Safari View Controller behavior; its older install defaults are superseded by the Safari 26 source below.
- [WebKit Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/): Home Screen `Open as Web App` defaults; no claim that this adds incoming-link capture.
- [Android deep links](https://developer.android.com/training/app-links/create-deeplinks): default handlers, domain approval and user choice affect external link routing.
- [Apple Universal Links](https://developer.apple.com/documentation/Xcode/allowing-apps-and-websites-to-link-to-your-content): native association and app handling requirements.
- [W3C pause/stop/hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide): continuous auto-motion needs a persistent control mechanism.

A guessed Chrome documentation URL `https://developer.chrome.com/docs/android/webapks` could not be opened. The brief relies on the successfully verified official Google PWA page instead. No physical iPhone/Android link-launch test, production-health check, all-provider live-account history audit or app test suite was run. Existing `npm test`/build commands apply to the forthcoming implementation; this pass only validates documentation scope, links and image artifacts.
