# Dibs visual refinement — implementation brief, 7 November 2026

**Design handoff only.** No application code, account data, deployment or legal publication changed. Scope incorporates the owner's current feedback; this supersedes the previous oversized onboarding guide treatment. Preserve gym-neutral adapters, real sharing/privacy rules, existing optional setup, and the correct finish-to-Home route.

## Direction: a personal concierge, composed like the app

Keep warm paper/clay, Fraunces page-title roles and crisp Inter controls. Bring the *actual Team creation* guide and Home/Team cards into onboarding: small conversational text, a properly framed character, decisive titles and useful compact cards. Avoid another large mascot hero, oversized speech panel or decorative feature catalogue.

The real Chrome baseline is linked in the [evidence receipt](../QA/browser-runs/sol-design-sweep-2026-11-07/README.md). Source inspected: `setup-guide.js`, `onboarding.js`, `name-capture.js`, `teams-create.js`, `team-avatar.js`, `teams-dashboard.js`, `calendar-section.js`, `spotmap.js`, `client/index.html`, relevant targeted CSS, and the server invite-shell handler. Gemini Flash located the bulk source; exact behavior below was independently checked.

## One guide system, all onboarding steps

Order the screen as **Back/progress → centered page title → guide → task/cards → floating action**. Title is a semantic heading with the existing page-title role, independent from the speech bubble. Main title 26–30px at ordinary mobile width; 22–26px on short screens; text wraps naturally. Eyebrow is optional and subordinate; do not stack competing titles.

Use the Team-avatar orb material without an emoji badge: a **96px circle at ordinary mobile sizes, 80px on short screens**, art at the existing 94% orb proportion. Team setup's current 112px orb is the reference, not a size requirement. Keep the character visually legible; no bare 50px character beside a huge headline. Guide sits centered beneath the title: small bubble above orb, or a compact side-by-side pairing where width permits. Prefer one consistent arrangement across steps; on compact phones use the side-by-side version to save height. Bubble uses the *actual* Team treatment: Inter 14px/1.4, 500 weight, 10–12px vertical/14–16px horizontal padding, 16–18px corners, maximum 28–30ch. It holds one short conversational sentence, never the page title. Replace the current protruding left diamond with one clean 6px integrated tail toward the mascot, or omit the tail in compact layout. No visible square/left-edge artifact.

Reuse `--lg-*`, `--orb-hi/lo`, surface/border and text tokens; do not add literal palette values or container opacity. A soft inner highlight and fine warm rim create glass; keep shadows restrained and use solid/reduced-transparency fallbacks. Existing DESIGN.md limits general card blur; the owner's current request explicitly expands the glass *appearance* to listed cards. Achieve most of it with tinted fill/highlight rather than multiplying backdrop-filter layers. Update the relevant design exception during implementation.

**Motion:** use existing 180/240/300ms tokens. Steps enter with opacity plus 12px travel, reverse direction on Back; cards stagger 25–35ms, total under 450ms. Guide does not bounce repeatedly. Change in-step states without replaying whole-screen entrance or losing focus. Reveal credential fields/collapsing cards with 180–240ms opacity/height transition, respecting natural height. Final exit: 240ms fade/8px lift followed by Home's existing entrance. Reduced motion removes travel, stagger and decorative motion; immediate update or brief opacity only. Focus moves to the new page heading after navigation, with no focus stealing during editing.

## Welcome: first feature list

Keep its five existing feature explanations, including Teams here. Center a distinct **Welcome to Dibs** page title; put a short concierge greeting in the small guide bubble. Use a single cohesive widget stack: each row has a 32–36px tinted icon tile, feature title and one short line of explanation. Match Home/Team card radius/material; 10px gaps, 12px padding, 14px titles/12–13px descriptions. Remove the current giant welcome speech heading and oversized wordmark-plus-heading stack. On ordinary 390×844 aim for all five rows and actions visible; on 320×568 permit sensible scrolling. Never shrink text below 12px or hard-clip the last card to satisfy an above-fold target.

## Your studios

Page title **Your studios**. Body exactly: **“Dibs works by logging into your gyms for you, so it needs your account credentials.”** Put this in readable body copy; do not repeat longer security claims in the bubble.

- Remove the **Pause logos** button. Replace infinite motion with one gentle **4.5s maximum** discovery pass, then a static, manually scrollable strip. Pause on hover/focus; reduced motion starts static. All five gyms remain discoverable by touch/keyboard without animation. This resolves the owner's button request without an endless uncontrolled animation.
- Preserve canonical full wordmarks, the existing 140×52 plates, optical per-brand scaling and Aarmy asset correction. Do not invent new assets or squeeze brand marks into generic icon crops.
- Flicker is reported, not root-caused in this pass. Verified source rebuilds the whole gym sheet during in-step render and runs a cloned 24s infinite transform. Developer must inspect first frame/asset decode, clone seam, transform distance and render restart before attributing a cause. Decode assets and reserve final plate dimensions; keep the track stable during form updates. With finite motion, remove decorative cloning if unnecessary. Do not use GPU promotion as an unexplained cure.
- Gym selector starts with **Choose a gym or studio**, no implicit first selection. Existing connected gym chips remain visible. No email/password fields or credential-submit button until explicit selection. A labeled native select is acceptable; do not replace it with an inaccessible custom list. Selection reveals a grouped labeled form; focus stays on chooser unless user advances. Use correct email/password autocomplete for the gym context.
- **Connect another gym** uses the app's glass secondary button with clear border and pressed/focus state. Continue is a visually distinct floating glass primary control: readable high-contrast ink, clay accent treatment, minimum 44px height, generous side margins. Preserve setup-later behavior for gym-less accounts.

## Name: personal, honest provenance

Centered title and centered first/last-name input presentation. Preserve both editable name fields and validation; last name remains optional as currently supported. If a trusted, unambiguous gym suggestion supplies the displayed first name, title **“Can I call you [name]?”** Body exactly for one source: **“Dibs found this on your [gym] profile. If you join a Team, your first name will be used to identify you.”** For multiple agreeing sources use “your connected gym profiles” and preserve the rest.

`inferNames()` already returns source names and rejects conflicting first-name suggestions. Saved account first name takes priority today: **do not claim a saved/edited account name came from a gym** when it differs. If provenance is absent/ambiguous, title **“What should Dibs call you?”**, with only the Team-identification sentence; retain valid account prefill. Escape interpolated names. The requested first-name explanation does not authorize changing existing Team display/privacy behavior (currently first name plus last initial).

## Make it yours: four setup widgets

Centered page title **Make it yours**. Mascot bubble exactly **“Set up these features to help Dibs work for you!”** Remove Teams from this screen only. Keep Notifications, Calendar Sync, Preferred Spot Maps and Auto-Upgrade in that order.

Reserve a **28px right status column** in every widget so state never shifts the text. Incomplete: neutral outlined circle plus explicit accessible “Not set up”; complete: compact clay/semantic check with accessible “Set up”. Remove bottom-left tick/“Set up” text. A completed widget collapses to icon + title + right tick; a disclosure/explicit Edit action can reopen it, but default presentation stays compact. Incomplete widgets retain description and an action aligned consistently at the bottom/right, minimum 44px target. Gap 12px; padding 14px; no extra frosted slab behind every nested child.

Auto-Upgrade uses a custom **44×26px glass switch** with native checkbox semantics or role=switch, visible label, Space support and clear focus. Keep its per-gym scope explicit and default off. A switch is a preference; the right check indicates persisted setup success. **Do not show completed before the setting save succeeds.** Current implementation defers enabling until exit and paints completion on checkbox change: developer must reconcile this (save on interaction with loading/error rollback, or separate “Will enable” pending state until successful exit). Preserve partial-failure reporting and retry; do not silently finish with a false success tick.

Final action always **Continue to Dibs**, whether optional items are complete or skipped. It exits to **Home**, preserving current route behavior. No “Continue to timetable” copy or forced detour to Teams.

### Calendar within onboarding

Use the same widget typography and spacing, 16px between feed status, included items/reminders and subscription destination cards. Show the data flow in concise plain text: bookings in Dibs → private calendar feed → selected calendar app; do not imply two-way edits. Enabled status is clear and compact, with a **Done** action returning to features and refreshing its persisted tick. Once enabled, **hide Refresh and Turn off in onboarding context only**. Add an explicit context option to the shared calendar renderer; Settings retains those management controls. Do not hide globally with a selector that breaks Settings. Subscription URLs/tokens remain private, and no feed generation behavior changes.

## Team creation and app refinements

**Keyboard:** preserve the actual glass mascot/small bubble. While Team-name input is focused, hide **Need ideas?**, suggestions and More ideas; restore on blur only after the keyboard settles. Within this editing state use a compact 80–88px orb/shorter guide. Treat visualViewport resize as a keyboard signal with focus, not the sole signal; hardware-keyboard focus should still hide Ideas. Header stays reachable; body is min-height:0 and independently scrollable. Action tray follows the visible viewport with 12–16px gap above keyboard; apply safe-area once, not both shell and button. No large blank well below Continue and no scroll-clipped mascot. Keep a subtle token-derived header shadow. Reduced-height Chrome is only a layout check; physical iOS keyboard remains mandatory acceptance.

**Team week:** tapping selected day again sets selection to none, closes class details **and See more**, and restores **Choose a day to see classes**. Focus stays on day; aria-expanded true→false. A different day opens its details; switching/closing resets expanded-more state. Verified current second tap remains true→true.

**Trending instructors:** remove visible **“Last 14 days vs previous 14”** and **“was x”**. Preserve calculation, current count, bars and +delta; retain comparison meaning in chart accessible description or compact information disclosure. Do not change the rolling comparison windows or Team sharing filters. Home's similarly named instructor widget currently uses 30-day counts; do not conflate or silently change that metric.

**Teams nav:** replace two-person symbol with a trophy in the existing SVG stroke, optical size and active/inactive treatment. Keep label/accessible name **Teams**, 44px+ target and route.

**About:** keep Tour first, Purpose second, Privacy third, with a deliberately composed page rather than three identical plain cards. Tour is a generous horizontal glass invitation: small restrained mascot orb, short title/body, clear “Take the welcome tour” action; on narrow screens stack naturally. Purpose is an editorial section with a distinct serif heading, brief existing product explanation and independent-companion caveat. Privacy is a calmer glass panel with a shield line icon, accurate existing encryption/decryption/deletion wording and Account settings action. No emojis, repeated feature catalogue or invented published legal links; drafts stay unpublished.

**Home inner cards:** Upcoming favourites, Credits & passes, Your activity and Trending instructors adopt the restrained Your Teams/class-card material (tinted translucent fill, hairline rim, soft top highlight, small shadow). Use shared surface recipe across `.home-favourite-card`, `.home-credits-tile`, activity tiles and instructor cards. Choose one glass plane per widget: an already frosted outer shell means inner tiles use the simpler tint/rim version. Preserve charts, counts, horizontal swipe and gym identity contrast.

**Settings spacing:** add 12–16px of *active pane* spacing between its header bar and page title. Preserve the earlier hidden-pane/scroll fix; do not restore global section padding or leak other pane content. **Auth fields:** soften placeholders via a dedicated token toward secondary ink, retaining at least 4.5:1 against the composited field background and persistent labels. Do not lower opacity on whole inputs or hide labels. **Spot picker:** shared editor needs 16–20px clear vertical space between “tap studio spots in order…” hint and Clear selection; preserve 44px clear target and gym-neutral geometry in onboarding and Settings.

## Link previews: answer and optional future work

**Yes.** Link previews can nominate an image using server-rendered Open Graph `og:image` (and platform-specific card tags), with a publicly fetchable absolute HTTPS image URL. [Official Open Graph protocol](https://ogp.me/) specifies image URL, dimensions and alt metadata. The receiving app controls final crop/display and may cache an earlier preview; updates need testing in actual target sharing apps.

Inspected app shell and landing currently have no `og:image`; the production `/t/:token` handler deliberately emits **generic** title/description for every token, valid or invalid. A future image should therefore be a public generic Dibs brand card, optionally a generic Team-invite variant, **not a private Team name/member photo/statistic or token-dependent image**. Bots cannot use a signed-in member's private page. Booking image export/file-sharing is a different feature from URL unfurl metadata. This question authorizes an answer, not generating/publishing an image or changing privacy design. X's legacy card-doc URL redirected to a general portal during verification; no platform-specific compatibility claim is established here.

## Acceptance and developer handoff

| Check | Required evidence after implementation |
|---|---|
| 320×568, 390×844, desktop 1280+, light/dark | Every requested screen; centered title, legible orb/bubble, no horizontal overflow, no footer masking final content; ordinary welcome fits when feasible, short screens scroll |
| Larger text / 200% zoom | No hard clipping or lost action; natural wrapping/scroll takes priority over above-fold target |
| Reduced motion / transparency | Static logo strip, no travel/stagger; solid readable fallback; all content available |
| Keyboard/focus | Explicit gym choice then reveal; labels/Tab/Space; Team Ideas hide/restore; focus kept after week toggle; physical iOS viewport/keyboard screenshot before claiming keyboard fix |
| Setup lifecycle | Initial/off, pending, saved, complete-collapsed, reopen/edit, error/partial failure; hidden calendar management only in onboarding; finish Home |
| Regression | Preserve slow-gym timeout/retry and 5s note, gym-keyed cache snapshots, metadata/geometry TTLs, source-of-truth profile names, real privacy filters and 14-day Team calculations |

Implement as one coherent refinement, using shared components rather than more final-CSS override patches. Before app edits, reproduce each targeted item in the same real Chrome; the flicker and physical keyboard causes remain unresolved. Read TESTING.md before adding tests; run `npm test`, client build, diff check and the real-browser matrix after changes. This brief itself has only documentation/evidence checks, not a claim that UI changes pass. Commit/push/deploy belongs to the next authorized development phase.
