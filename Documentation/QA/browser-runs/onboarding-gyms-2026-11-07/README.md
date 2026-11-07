# Onboarding and gym availability — 2026-11-07

Status: source fixes verified; production deployment pending.

## Evidence before edits

- Teams includes master `b98cccc` and gym integration `6254b3b`. Production registry contains Homerun and Barry's, but `HOMERUN_ENABLED` and `BARRYS_UK_ENABLED` are absent. Both resolve disabled; JAB and Aarmy resolve enabled. Earlier Barry attendance receipt explicitly enabled these flags on dev only.
- Real Chrome CDP, local mock: a Psycle-only `appUnifiedCacheMeta` entry with three linked gyms renders only Psycle in Preferred Spot Maps. `openManageSpotMapsModal` treats nonempty lists as complete and never checks linked-gym coverage. Cold loading awaits merged metadata and then a 28-day timetable fetch; errors are swallowed.
- Shared server metadata cache already has a 30-minute TTL (stamp ceiling six hours); studio geometry has a 24-hour TTL (maximum stale seven days). No shared booking/private occupancy expansion is needed.
- Real Chrome, 320×700: existing Teams empty-state primary CTA bottom 936px; bottom navigation starts 630px. Redundant empty-state page heading consumes space.
- Real Chrome rerun skips name directly from gyms to features. `stepName` deliberately skips saved first/last names; `finish` preserves the Settings URL. Gym-logo strip uses responsive chips, selecting Psycle's compact mark on mobile; Aarmy wordmark measures 40px, on a 120×48px plate. Only three enabled gyms means static wrapped grid.
- Calendar coverage and weekly-reminder help insert gym names; the feed is account-wide across linked gyms.

## Corpus coverage

Gemini Flash locator calls: project instructions/Teams plan; onboarding/settings/cards/Teams/styles/cache; infrastructure registry/Oracle/deploy runbook. Direct source and Chrome checks above verify the relevant claims. No third-party live gym writes or new infrastructure exposure.

Legal drafts remain unpublished. Mail alias configuration is recorded below.

## Privacy email setup

User verified the destination. Cloudflare routing is enabled/ready and exact rule `5441489ae7804237b85aeb8d07f77339` forwards privacy@dibs.fit to dibsadmin@piersj.com. Catch-all remains disabled. No pre-existing MX/TXT mail records were present. Cloudflare provisioned three MX records, one SPF record and its DKIM TXT. Public DNS checks return all three MX and a single SPF. End-to-end email delivery was not tested. Legal drafts remain unpublished; legal-name/address/governing-law prerequisites remain unresolved. Official references: [destination verification](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/), [routing API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/), [DNS setup API](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/).

## Fixes and checks

- Preferred-map loading explicitly requests every enabled linked gym, renders independent results as ready, and gives each gym a 20-second ceiling plus its own retry. It never infers linked-gym coverage from a partial timetable cache. The redundant blocking 28-day timetable fetch is removed. Server metadata/geometry caches are preserved; booking/private occupancy caching is unchanged.
- The five-second polite message is “Still waiting for some gyms to load.” Generation guards and timer cleanup prevent stale responses changing closed/reloaded screens. Offline metadata snapshots now include the gym ID.
- Name is shown during a full welcome tour with existing values prefilled; normal completion replaces the current route with Home. The explicit Create/join Team action retains its Teams destination.
- Referee and speech bubble guide all tour screens, reusing the Team mascot/bubble implementation. The five enabled gym logos use full wordmarks and identical 140×52px plates in a single horizontal marquee, with a pause control, focus/hover pause, decorative duplicate track, and a static scrollable row under reduced motion. Your Gyms uses the same uniform plate helper.
- Calendar copy describes the single account feed across linked gyms. Empty Teams hides only its redundant page title and places Create a Team before benefit rows, preserving natural scrolling for larger text.
- Final `npm test`: **121/121 server suites; 119/119 client files; 965/965 client tests**. The initial run's single offline-key expectation was updated and a cross-gym isolation case added. Final build: **127 modules transformed, success**. `git diff --check`: no output / exit 0.
- Real Chrome: five logos/plates at 390px and desktop, full wordmarks, pause/reduced-motion and dark mode, no horizontal page overflow. Settings visible plates all 140×52px. At 320×568 the empty Teams CTA bottom is 325px and navigation begins at 498px. Existing Teams list retains its title.
- Real Chrome partial-cache repro now shows Aarmy, JAB/SW1 and all Psycle locations independently. A held Psycle metadata request shows ready JAB plus the exact five-second note; releasing it fills Psycle and hides the note. Name screen appears with prefill, and completing the full tour lands at `/`.
- Production preflight: database integrity ok; 2 users and 3 links, including 0 Homerun/Barry links. WAL-safe rollback database plus original `.env`/compose saved at `~/services/sweatassistant/rollback-onboarding-20261107`; rollback image tagged `sweatassistant:rollback-onboarding-20261107`. No database recreation or gym write occurred.
