# Work plan: app design, typography, CSS and motion

**Status:** Proposed, 2026-10-24. Planning only; no application changes or completed visual audit.

## Outcome and direction

Bring the PWA into the visual family of the current Dibs landing page: warm surfaces, restrained glass, clay accents, crisp sans-serif controls and expressive serif used with a clear hierarchy. Preserve the density and speed needed to browse classes and book on a phone. Deliver equally deliberate light and dark themes, rather than deriving dark mode by mechanically inverting the light-only landing page.

The reference is the implementation in `landing/index.html`, not just the older landing spec. Keep its independent deployment; share documented token meanings and component recipes without importing marketing-page CSS into the PWA.

## Evidence and limits

- `landing/index.html` defines Fraunces/Inter, warm light surfaces, 20px cards, 12px controls, two shadow levels and glass fallback rules. Its marketing scenes and tilt effects are reference material, not an app interaction specification.
- `client/src/styles.css` already has the same font families, a type scale, theme tokens and reduced-motion rules. It also contains a blanket heading-serif rule, explicit font-family declarations and successive override batches. These are inspection targets, not proof of a rendered defect.
- `Documentation/DESIGN.md` section 4.1 explicitly requires serif on all headings. The proposed selective hierarchy requires updating that rule and related examples alongside implementation.
- The [CSS debt audit](../Audits/css-debt-audit.md) contains historical counts and a completed dead-rule removal pass. Recalculate the baseline; do not repeat old deletion lists or describe that cleanup as undone. Current neutral `app-` names also make the archived prefix-rename proposal partly stale.
- **BLOCKED: no real-browser access** for the visual audit: CDP `127.0.0.1:9222` was unreachable and Claude for Chrome was unavailable in this session. Planning continues; visual findings and implementation must wait for the [agent protocol](AGENT_PROTOCOL.md) checks.

## Phase 1 — establish the baseline

1. Attach to the user's Chrome and record the landing page plus app at narrow mobile, wide mobile/tablet and desktop widths. Include both themes, automatic theme changes, reduced motion, keyboard navigation and text zoom. Installed iOS PWA checks cover safe areas, scrolling, keyboard and full-screen modal navigation.
2. Inventory Home, Timetable, Bookings, Auto-Book/Upgrade, credits, Settings, favourites, onboarding, account/gym connection and every modal family. Include loading, empty, error, disabled, offline, selected, waitlisted and success states; multi-gym data, long names and timezone suffixes.
3. Build a CSS map: source order, duplicate/conflicting declarations, selector specificity, `!important`, inline styling, raw values, font overrides, media/theme combinations, keyframes and custom properties. Inspect JS-generated markup and dynamic class builders.
4. For each issue, record selector/component, computed winning rule, screenshot, affected states, desired behavior and whether it is a defect or a design choice. Separate confirmed unused code from candidates and dynamic cases. CSS coverage from one session is only a hint.
5. Refresh the old cleanup items against current code and browser evidence. Output a short prioritized audit and before-images in the existing QA evidence structure.

**Exit:** a reproducible visual baseline, current CSS metrics and a scoped migration list. No mass deletion or speculative restyling before this gate.

## Phase 2 — define the visual contract and reference screens

Create reference treatments for Home, a dense timetable, a booking card and a full-screen booking/spot-selection flow, in both themes and at mobile/desktop widths. Use them to settle the following rules before broad migration:

| Role | Proposed treatment |
|---|---|
| Brand, page title, occasional editorial section title | Fraunces; restrained size and weight; purposeful whitespace |
| Dense card titles, class names, settings groups, modal subsections | Inter by default; serif exceptions only where demonstrated to improve hierarchy |
| Navigation, buttons, filters, tabs, labels, badges, form fields | Inter with shared size/weight tokens |
| Times, counts, credits, countdowns | Sans-serif with tabular figures where alignment matters; avoid decorative numerals in dense data |
| Supporting copy | Inter; hierarchy through weight, spacing and contrast, with the existing 12px minimum |

Keep semantic heading levels independent of their visual font. Replace the blanket `h1`–`h4` font rule with explicit visual roles; do not downgrade headings to ordinary text to obtain sans-serif styling.

Specify surface hierarchy, glass placement/fallbacks, radii, spacing, focus, button variants and state colors. Reconcile landing clay with the existing dark-theme interactive blue and reserved feature colors. Check actual contrast on composited glass and opaque fallback surfaces; matching token names is insufficient.

**Exit:** reference screens and updated design rules that subsequent changes can be compared against. Resolve visual direction here, before migrating every page.

## Phase 3 — clean the CSS without changing appearance

Work in small component batches with before/after checks:

- Establish clear sections for tokens, foundations, shared components, page-specific rules and responsive/theme adaptations. Keep the current stylesheet entry point initially. Consider splitting source files only if it improves ownership and the build preserves intended cascade order.
- Consolidate winning declarations into the owning rule, then remove obsolete overrides. Reduce specificity and `!important` together; deleting one declaration can expose an older rule. Do not introduce cascade layers over a mixture of unlayered rules without a tested migration strategy.
- Move presentational inline styles to shared classes/tokens; retain genuinely computed layout values as explicit custom properties where appropriate.
- Remove demonstrably unused selectors, IDs, keyframes and variables only after checking dynamic names, conditional rendering, generated markup and all theme/viewport variants. Keep an evidence list for each deletion batch.
- Preserve `[hidden]` enforcement, table-column sizing, layout bounds, capability gates and the shared `modal-nav.js` full-screen mobile contract.

**Exit:** equivalent rendered behavior, fewer conflicting rules and a current audit. Do not set an arbitrary zero-`!important` target or claim a selector is dead because a text search missed a template.

## Phase 4 — migrate the app through shared components

Order: tokens/type roles → shell/navigation → controls and status treatments → shared cards/tables/filter bars → modal and spot-map flows → remaining page-specific surfaces. Keep mobile density, action visibility, theme parity and gym identity consistent at each step.

Review the [reported member-experience issues](EPIC-member-experience.md) when touching their components. In particular, U6-2, safe-area theme updates; U6-4, mobile time size; U6-10, the collapsed gym-filter line; U6-11, mobile refresh animation; and U6-13, timezone-extended timetable layout need coordinated checks. Functional fixes remain in their existing items; do not silently fold search or booking behavior changes into restyling.

**Exit:** all inventory surfaces use the agreed recipes, with evidence for each migrated family and no mixed old/new typography in the same flow.

## Phase 5 — add a coherent motion language

Build a few beautiful, reusable interactions rather than separate effects on every page:

| Interaction | Proposed motion |
|---|---|
| Navigation and full-screen modal transitions | Directional 180–300ms movement with restrained opacity; preserve native back direction and focus |
| Filters, drawers and expandable cards | 180–240ms expansion/reveal with a stable anchor; no scroll jumps |
| First meaningful content arrival | Brief, capped stagger on a small visible group; never replay on every refresh or SSE update |
| Favourite, spot selection and action feedback | 100–180ms tactile emphasis; clear pending/success/error states tied to the actual response |
| Confirmed booking or upgrade | A single restrained success flourish, with persistent readable confirmation |

Use shared duration/easing tokens and the existing spring curve as a starting point. Prototype timing in the reference screens. Prefer transform/opacity, avoid animating large blur surfaces, and profile any height/layout animation. Handle interruption, rapid repeated taps, view changes and listener/animation cleanup.

Reduced motion uses immediate state changes or minimal fades; all information and interactions still work. Avoid continuous ambient animation in the daily-use app, motion on every countdown tick, delayed booking controls and movement that suggests success before the server confirms it. Keep the existing mobile refresh-animation restriction.

**Exit:** motion feels consistent on a real phone, remains responsive during data updates, and has a complete reduced-motion treatment.

## Phase 6 — acceptance and rollout

- Run `npm test` and the production client build for implementation batches. Add tests for changed behavior when useful; CSS cleanup does not need tests that merely mirror declarations.
- Repeat the baseline Chrome flows and installed iOS checks, clearing service worker/CacheStorage, IndexedDB and reloading as required by the agent protocol. Capture matched after-images.
- Check 200% text zoom, visible focus, screen-reader headings/status announcements, touch targets, contrast, offline states, theme switching and unsupported-glass fallback.
- Compare CSS/gzip size, cascade metrics and representative interaction/scroll traces with the baseline. Investigate regressions rather than promising an unmeasured frame rate or arbitrary percentage reduction.
- Release through the dev twin first after verification. Production deployment remains a separate action using the repository's deployment procedure.

## Roadmap ownership and sequencing

This plan coordinates U3-1, neutral selector naming; U3-2, cascade/`!important` cleanup; U3-3, type tokens; U3-4, inline presentation; U3-5, shared card typography; U3-6, gym-neutral copy/storage audit; and U4-10, additional glass styling. Their status remains in [BACKLOG.md](BACKLOG.md) until implementation is scheduled; completed work discovered during the audit is recorded there with evidence. Broad storage-key or naming migration is included only if the refreshed audit finds remaining work.

Recommended delivery slices: (1) audit and visual contract, (2) cascade cleanup, (3) shared foundations plus one complete reference flow, (4) remaining components, (5) motion and acceptance. Estimate implementation after the audit exposes the true cascade and state coverage. The MCP work can proceed independently; only its settings/consent UI needs these shared design components.
