# SOL design baseline — 7 November 2026

Design-only inspection using one owned tab in the user's real Google Chrome, raw CDP `127.0.0.1:9222`. Local running app `localhost:5173`, existing mock session. No app-source changes, settings saves, Team creation, live gym requests or deployment. The tab is closed after evidence capture. Existing user tabs are untouched.

## Captured evidence

- [Welcome, 390×844](welcome-baseline-390.png): large title bubble crowds the five feature rows.
- [Your studios, 390×844](gyms-baseline-390.png): bare small mascot, large left-tail title bubble, visible Pause logos and existing connected gyms.
- [Name, 390×844](name-baseline-390.png): current title, name fields and multiple-profile explanation.
- [Make it yours, 390×844](features-baseline-390.png): large heading bubble, tall cards, Teams below fold, old bottom action copy.
- [Actual Team creation, 390×844](team-create-baseline-390.png): reference 112px glass orb, 14px speech bubble, 11×16px padding.
- [Team creation, reduced viewport](team-create-short-viewport.png): 390×500 simulated layout with focused name; **not an actual iOS keyboard**.
- [About, 390×844](about-baseline-390.png): existing Tour, Purpose and Privacy panels.
- [Team week after second tap](team-week-second-tap-baseline.png): code/browser state confirmed repeat tap does not close selected day; widget may be below initial screenshot fold.

## Actual browser outputs

```text
Your studios at width=390:
select = homerun-london
email field height = 44
password field height = 44
onboarding title font = 21px

Actual Team creation at width=390:
.tm-cf-bubble font = 14px
.tm-tav-lg width=112 height=112

Team name focus:
ideasVisible = true

Team week selected day 1:
first tap aria-expanded = true
second tap aria-expanded = true
```

Marquee flicker was not reliably reproduced as a frame/asset defect and is **not root-caused**. Source confirms cloned 24s infinite track and full sheet rebuild on in-step render; these are investigation targets. Keyboard clipping is reported by the owner and reduced viewport inspected, but physical iOS behavior remains unverified. No after-state UI evidence exists because this is a design handoff.

Gemini Flash: one bulk locator call (instructions/progress/design/onboarding/Teams/CSS); claims independently checked by targeted source and browser. One grounded Gemini preview lookup, independently verified against [Open Graph](https://ogp.me/). Legacy X card documentation redirected to general docs, so exact X support remains unverified.

See [implementation brief](../../../Workstreams/TEAMS-ONBOARDING-DESIGN-2026-11-07.md).
