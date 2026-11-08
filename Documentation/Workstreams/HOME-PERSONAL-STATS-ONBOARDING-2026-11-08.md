# Personal statistics and final onboarding refinements

Design brief, 2026-11-08. Ready for a separate implementation pass. This pass changes documentation only: no app implementation, commit, push, deployment, host access or infrastructure change is authorized. Preserve all existing untracked character art and QA images. Do not merge into master. Deployment needs a new, explicit instruction for the chosen environment.

Evidence: [baseline receipt](../QA/browser-runs/personal-stats-design-2026-11-08/README.md). Source HEAD was `58c9872`; current operations identifies production app release `4e92430`, which was not reverified on a host in this pass. Local browser observations are not production-health evidence.

## Product decisions and exact copy

Use existing design tokens, glass surfaces, type hierarchy and copy binding. Put new authored strings in `client/src/copy.js`; use `appCopy`/`{appName}` for product names. Do not hardcode the current brand in markup or tests.

### Welcome and studio connection

- Preserve the page heading `Welcome to {appName}`. Center the compact mascot speech bubble and its text; its exact new text is `I’m your boutique fitness concierge!`. Scope this styling to onboarding rather than changing every Team creation bubble.
- Keep the `Your studios` heading. Replace its bubble text `Bring your studios together.` with `Connect your favourite studios, and I’ll help you manage them!`. Keep the bubble centered and allow its longer text to wrap naturally at 320px.
- Remove the signup-success toast `Account created — now connect a gym` at `client/src/main.js:1957`. Keep the existing success navigation and error handling.
- Replace the finite eased logo discovery with a slow, continuously repeating **linear** cycle. Current `client/src/ui/gym-logo-strip.js` moves `scrollLeft` once over 4.5 seconds with a cosine easing; stopping at the right edge is its intended current behavior. No network/update rerender should restart or replace the live strip.
- Render two identical, fixed-size tracks with a precise repeat gap; translate by one complete track width, including its gap. Use the same uniform logo sizes, decode assets before starting, and compute a constant speed around 16 CSS pixels/second. Duration derives from track distance, not number of rerenders. No easing, bounce, per-logo entrance animation or gap at the seam. The second track is decorative and hidden from accessibility APIs.
- Do not add a visible **Pause Logos button**. Make the whole strip the pause/resume control, with keyboard Enter/Space, visible focus, an accessible action/state label and a discreet non-button hint `Tap the logos to pause` / `Tap the logos to resume`. An explicit pause remains paused after focus/hover leaves. Hover/focus pauses temporarily; reduced motion gives a static manually scrollable strip and no automatic movement. Keep the accessible static gym chooser. Do not put interactive logo links inside a button-like strip. Test pointer/touch activation, keyboard activation and reduced motion. This supplies a persistent pause mechanism without the rejected extra button; hover/reduced-motion alone are insufficient for continuous auto-motion ([W3C explanation](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide)).

### Make it yours: Auto-Upgrade eligibility

Current `stepFeatures` (`client/src/ui/onboarding.js:922`) renders an enabled switch while `refreshStatus` checks maps separately. Its `hasSpotMap` also accepts `preferredRows`, which is too broad for this request.

- An OFF switch may turn ON only after at least one linked, enabled, Auto-Upgrade-capable gym has a successfully saved map with at least one actual `preferredSlots` selection. An empty map, merely opening the editor, `preferredRows` alone, a failed preference request or a noneligible gym does not qualify.
- Until eligible, show a native disabled, visibly muted switch and adjacent exact copy: `Set up some preferred spots before you enable Auto-Upgrade.` Connect the explanation using `aria-describedby`; do not rely on color alone. Keep preferred-spot setup available.
- Re-evaluate from saved preferences after returning from spot-map setup and on `app-studio-preferences-mutated`. Gym-qualified map keys prevent studio-ID collisions. If eligibility becomes unknown while an ON action is being processed, fail closed for that ON action.
- Keep the existing persist-before-success behavior, disabled pending state, failure message and unchecked rollback. A failed enable must not show a completion tick. Do not enable every gym from the mere fact that a different gym has a map: apply the existing enable helper only to eligible gyms, and state which gyms were enabled.
- Preserve the existing already-on note for accounts already configured. Never prevent an existing enabled setting being turned OFF in Settings because a map was removed. The requested onboarding guard does not introduce a broad new server setting invariant or silently disable existing monitoring.

### Timetable date selector

Remove only the right overhanging white/blur fade of the date row. The shared observer in `client/src/ui/edge-fades.js` includes `.app-wk-scroller`; CSS `.has-edge-fade` at `styles.css:12863` masks edges globally. Give the timetable date scroller a narrow right-edge exemption; retain its scroll/pager, dates, swipe hit areas and arrows. Preserve any requested left behavior and all other scrollport fades. Inspect the actual offending computed style before editing: a mobile snapshot initially read `mask-image: none`, while a subsequent sample showed `app-wk-scroller has-edge-fade fade-right`. The right edge visibly fades in the screenshot. Recheck computed styles after the observer settles; do not assume every white blur shares this cause.

### Teams loading and no-Team page

- `client/src/ui/teams.js:69` currently replaces a new list with a spinner. Use a list-shaped skeleton: page heading/action placeholders, two neutral card blocks with avatar/line placeholders and a lower footer line. `aria-busy=true` on the list region; one polite `Loading Teams…` status; skeleton shapes are decorative. No invented Team names, member counts or goals. Reduced motion disables shimmer. Preserve an already loaded list during refresh; do not briefly render the empty pitch while the request is pending. Failure becomes the existing retry state.
- Remove the **entire** first pitch row, `See who’s training`, from `pitchRows` in `client/src/ui/teams-pitch.js`. Exactly two benefit rows remain.
- Exact copy replacements in `COPY.teams`:

| Element | New text |
| --- | --- |
| Headline | Training is more fun together! |
| Intro | Bring your workouts out of the group chat with a Team! Teams are private groups to make training a shared habit. |
| First remaining benefit title | Stay in sync |
| First remaining benefit body | Know when your teammates are training, and then in a tap. |
| Goal benefit title | Chase a goal |
| Goal benefit body | Set a weekly target and watch your Team fill it up, class by class. |

The `Stay in sync` body intentionally preserves the user's exact wording, including `and then in a tap.`; do not silently rewrite it. Keep privacy and invite-link guidance, the hidden redundant page title and existing empty-page containment. Add distinct space above and below the Create button (start at 18px above and 16px below). At 320×568, keep the primary button fully visible above bottom navigation; reduce decorative mascot footprint/padding before shrinking copy or controls. The longer intro and two benefits should feel breathable rather than tightly stacked.

### About

The rendered About card is authored in `client/index.html:560`, not the unused-looking `COPY.static.privacyDescription` alone. It currently always uses `/characters/team-referee.webp`.

- Select one valid local mascot once per entry into About, reuse that choice through incidental renders, and allow a new choice on a later visit. Reuse the valid local mascot mappings in `client/src/ui/teams-ui.js` rather than external art or raw `characters/*_alpha.png` inputs. Keep the image decorative (`alt=""`, hidden from accessibility APIs), reserve its dimensions, and fall back to the existing referee if an asset fails.
- Remove precisely the final clause `; backups and copies shared elsewhere may remain.` from the **About Privacy & data card**, ending the preceding sentence `Delete your account and live data from Account settings.` Retain account/gym identity separation, encryption at rest, decryption on the server for syncing and booking, and Team-sharing control. Update a copy token if that token is actually bound here; do not change signup privacy text or legal drafts as an incidental global replacement. Removing this summary clause changes no real backup behavior, retention or legal publication status.
- Preserve welcome tour first, purpose second, privacy third, existing typography and Account settings action.

### Home visibility and Find a class

- Hide the entire `Upcoming favourite classes` widget, including heading and reserved space, only when there are **no saved favourites across all linked gyms**. The current renderer has an empty state but no saved-global-count visibility guard (`home.js:834`). An existing favourite whose next class is outside the seven-day schedule retains the widget and existing no-upcoming-match message.
- Resolve saved counts independently of schedule availability. A failed or not-yet-loaded gym must not be treated as zero. While membership/counts are unresolved, avoid showing an empty card or bouncing its heading in and out. Keep prior resolved data when safe; otherwise use a neutral loading treatment until the visibility decision resolves. Include linked disabled gyms in the saved-count decision; enabled gyms still own the available-class rows. Recalculate on favourite changes, link/unlink and logout/account switch, not just active-gym changes. Cache keys remain account and gym scoped.
- When no future **confirmed booking** exists, show exact copy above the finder gym actions: `You have no classes booked! Why not choose a session?`. Use an inviting, readable two-line treatment with a restrained accent/emphasis and sufficient contrast; no warning/error styling. Retain existing finder links. One or more future confirmed bookings hide the complete finder; waitlists alone do not. Preserve the existing gym-connection state when no gyms are linked, because there is no session to choose yet. Do not show this empty-bookings message on a booking-fetch failure.

## Personal activity widget

Upgrade the existing `Your activity` widget rather than adding a duplicate. Current `home.js:121–271` renders official provider attendance totals; those provider APIs/data remain available for gym settings. The new habit charts use private normalized booking history and must not be labeled official attendance. Do not change or delete stored history, provider totals or settings.

Reuse the Team stats card surface, spacing, horizontal scroll behavior and accessibility patterns, but not Team goal logic, daily streak logic, member projections or sharing-limited data. Personal activity answers “what does my training habit look like?” It has no goal setting, no `classes this week` counter, no week-over-week comparison and no duplicate trending-instructors panel.

Proposed compact layout:

1. `Your activity` heading, a small **weekly streak** summary, and a subtle `Based on your past booking history` explanation. An unobtrusive coverage/status line appears only while history is importing, stale or partial.
2. A horizontal chart-card rail in this exact order: **Training volume — Last 30 days** (line), **Busiest days — Last 90 days** (Mon–Sun bars), **Gym mix — Last 90 days** (labelled distribution bars with count/percentage), **Busiest times — Last 90 days** (six labelled four-hour bins). Clearly show each period; do not imply all charts use the first chart's period.
3. At 390px, a card is roughly 285–310px wide with the next card peeking into view, 12px gap and 190–220px plot/content height. At 320px, reduce width to preserve readable labels. Desktop may show two cards within the Home column; keep a bounded rail instead of making Home four charts taller. Native horizontal scrolling, keyboard focus and accessible previous/next controls are available; do not trap vertical scrolling.

Data semantics:

- One class is a distinct `(gymId, eventId)`; fall back to `(gymId, bookingId)` for missing/empty event IDs. Guest/multi-seat booking rows do not multiply a class. IDs from different gyms never collide. Accept only `attended` and `unconfirmed`; exclude cancelled, late-cancelled, no-show, class-cancelled, waitlist and future classes. Where duration is known, exclude a class whose end is still in the future. An unknown duration must not be invented or described as proof of completion; the record remains a past booking according to the provider history contract.
- Labels say **past classes/bookings**, not verified attendance or calories. CodexFit past bookings lack individual attendance signals; official milestone totals differ. The status note must remain understandable without exposing raw provider diagnostics.
- Calendar weeks run Monday–Sunday. A week counts when it contains at least one eligible past class. If the current week is still empty, count the consecutive run ending last week; the unfinished current week does not break a streak. Once a full week has been missed, the current streak is zero. A class in the current week extends the previous consecutive run. No daily streak and no arbitrary 30-day streak cap.
- Fix the account/viewer's valid IANA zone for week boundaries and the 30-day line (today plus the preceding 29 calendar days), using existing zone helpers and calendar arithmetic across DST. Bucket each event instant into that analysis zone for those longitudinal measures. Day/hour habit charts use each class's own normalized gym zone and say `Class-local times`. This deliberate distinction keeps a cross-gym weekly timeline coherent while comparing morning/evening habits as experienced at each studio. Do not hardcode London; validate a zone input and use a documented UTC fallback if none is available.
- The line has exactly 30 zero-filled daily buckets, a zero-baseline integer axis, straight segments and restrained area fill. No spline smoothing that invents peaks; no cumulative total masquerading as daily volume. Pointer/focus can reveal date and count; supply a text summary/table alternative. Bars include labels/counts, gym mix adds percent, and color is never the only key.
- No data is a friendly real empty state after successful completed imports. Initial importing, failed gym fetch, partial successful coverage, disabled stored-only gym and stale cached data are distinct. Preserve successful gyms on failure and provide retry without clearing the widget. Do not present missing histories as zero classes or a definitive zero streak. For partial coverage, describe streak as `at least N weeks from available history` where useful, and make incompleteness clear. Successful zero history has a true zero state.

## Verified history procedure and implementation seam

The owning source is `server/class-history.js`:

- `syncUserGym` pulls normalized rows with the **row's gym session**, then transactionally upserts SQLite `class_history`, unique by user/gym/provider booking ID. Only normalized fields persist, not `.raw`; per-gym sync metadata records success time, attempt, error and row count. Concurrent calls for the same user/gym share one in-flight operation. A 401 attempts the existing gym-specific auto-relogin. Failure preserves stored rows and the last successful sync time.
- `POST /api/my-gyms/link` starts history sync after linking or reauthenticating (`routes-normalized.js:326`). The first `/api/history` access awaits a full backfill when there is no successful sync. A later stale access serves stored history and refreshes in the background. Login by itself does not force a fresh full backfill.
- The poller scans missing or stale enabled links at `25 */6 * * *` (`poller.js:1375`); the stale threshold is six hours. Incremental refresh rereads from last successful sync minus **14 days**, allowing recent outcomes to settle. This is distinct from the upcoming booking-cache sync, which ticks every 15 minutes. Suspended links, disabled gyms and provider backoff constrain background fetches.
- Psycle uses CodexFit v2 `/bookings?filter[type]=past&page[size]=100&page[number]=P`, following `meta.last_page`. Existing captured evidence in code shows history predating Dibs, but the adapter has a 60-page guard. It filters incremental dates locally; it still walks provider pages. Rows are `unconfirmed` unless cancelled. No provider-verified attendance can be inferred from an individual uncancelled CodexFit past booking.
- JAB, Homerun, Barry's and Aarmy share MarianaTek's implementation: `/me/reservations?is_upcoming=false&page_size=100`, following `links.next`, with `min_start_date` on incremental pulls and the same 60-page guard. It applies the configured class scope, excludes waitlist/nonbooking rows, and normalizes check-in, pending, cancellation and no-show outcomes. This verifies code coverage, **not live account history completeness for all four gyms**.
- There is no periodic age-based history purge in this module. Normal unlink deletes that user's rows and sync metadata for that gym (`db.js:2550`); account deletion removes its live data. Disabled links retain stored history without outbound fetches. A lapsed session or failed refresh does not erase history. Backups are a separate concern. Provider limits, omitted rows, missing normalized dates/statuses and the 60-page guards mean “everything the provider returned within our safety limit,” not a guaranteed complete lifetime attendance record.
- `/api/history` currently defaults to 365 days, clamps to 3,650 days and at most **1,000 returned rows**, while its `summary` counts stored rows over all time. Team recent history is additionally sharing-limited and 30 days. Neither endpoint/list is a sound source for a complete personal weekly streak.

Small implementation seam:

- Add a private authenticated account-level aggregate endpoint, e.g. `GET /api/personal-stats?zone=<validated IANA zone>`, using existing read limiting. It resolves linked gyms from the authenticated user, never from a caller-supplied user ID or arbitrary gym IDs. Add the DB read/aggregation entry point in **class-history.js**, which remains the only reader/writer of its tables; a pure aggregation helper can accept normalized rows if useful. Do not put raw class_history SQL in a new stats module or a client-facing route.
- Aggregate all stored eligible history for the weekly streak, then bounded chart windows; return only a small summary/bucket payload plus per-gym import/sync coverage, earliest stored date and aggregate `partial`/`pending` flags. Do not download thousands of raw rows to the browser or remove the safety caps. Include disabled linked gyms' stored history without contacting them; after unlink those rows disappear by current policy.
- Reuse existing sync/ensure and in-flight dedupe; do not create a second provider-fetch pipeline, new cron, new ledger or cache that owns a competing history. The endpoint may serve aggregates immediately and start established missing/stale imports in the background, exposing pending status. During a first backfill the client may boundedly refresh the aggregate using the same account-scoped cache until completion; cancel polling on leave/logout and back off on failures. Keep provider pacing, outbound blocking and gym enablement intact. Do not synchronously burst full-history calls for every linked gym on every Home render.
- Home uses one account-scoped aggregate cache entry keyed by analysis zone and invalidated on gym link/unlink, logout/account change and history refresh. Existing favourites, bookings and Team projections retain their owners. Personal stats never change Team consent or publish private historical details to teammates.
- Existing adapters do not flag safety-cap truncation explicitly. Do not claim complete lifetime import. If an import reaches its guard, expose partial coverage rather than silently asserting completeness; any minimal completion metadata extension must preserve existing normalized adapter contracts and be tested. Do not infer completeness solely from a small response's row count.


Concrete aggregate response contract (illustrative field names for the implementation):

```json
{
  "analysisZone": "UTC",
  "generatedAt": "<ISO instant>",
  "basis": "past-bookings",
  "partial": false,
  "pending": false,
  "streak": { "weeks": 6, "atLeast": false },
  "volume": { "days": 30, "points": [{ "date": "<YYYY-MM-DD>", "count": 0 }] },
  "patterns": {
    "days": 90,
    "weekdays": [0, 0, 0, 0, 0, 0, 0],
    "timeBins": [0, 0, 0, 0, 0, 0],
    "gymMix": [{ "gymId": "<linked gym>", "count": 1, "percent": 100 }]
  },
  "coverage": [{
    "gymId": "<linked gym>",
    "state": "ready",
    "lastSyncedAt": "<ISO instant or null>",
    "earliestStoredAt": "<ISO instant or null>",
    "limited": false
  }]
}
```

`volume.points` contains all 30 points, not the single illustrative element above. Coverage states are `pending`, `ready`, `stale`, `failed`, `disabled`; `limited` separately signals known truncation. Do not send provider error strings to the UI. A first import with no successful history sets `pending`; failure or known limitation sets `partial`. Per-gym status and successful aggregates survive a different gym's error. Use 401 for unauthenticated access; a legitimate account with no linked gyms returns an empty successful account-level result. `ready` means the latest bounded sync succeeded, not certified lifetime completeness. The endpoint must never return another account's details or accept arbitrary query gym IDs.


## PWA link behavior: answer and app-specific boundaries

An installed icon does **not** guarantee that an external HTTPS link opens the installed app.

- **iPhone/iPad Home Screen PWA:** an ordinary link from Messages/Mail or the browser should be expected to open the web/browser experience; an installed web app cannot claim incoming HTTPS links the way a native Universal Link app can. Google’s PWA guidance states that URL capture is unavailable for Safari-installed iOS/iPadOS PWAs ([OS integration](https://web.dev/learn/pwa/os-integration)). iOS 26's default `Open as Web App` changes how the Home Screen icon launches, not a documented incoming-link capture guarantee ([WebKit Safari 26](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).
- **Android Chrome installation as a WebAPK:** matching in-scope links can open the installed PWA because the WebAPK registers scope URL handlers. This is the documented supported path, not a promise for every Android browser, shortcut-only installation, embedded in-app browser or user default. Android routing can depend on domain approval and the user's default handler ([Google PWA guidance](https://web.dev/learn/pwa/os-integration), [Android routing](https://developer.android.com/training/app-links/create-deeplinks)).
- **Already inside the installed PWA:** ordinary same-context navigation to an in-scope URL stays inside the app. An out-of-scope destination uses browser UI; Apple documents Safari View Controller for iOS Home Screen web apps ([Apple WWDC23 scope discussion](https://developer.apple.com/videos/play/wwdc2023/10120/)). A `target=_blank`, explicit external launch or OS handoff can change the context.
- **Native iOS Universal Links** need a native app with Associated Domains entitlement, corresponding website association and native link handling. Adding an `apple-app-site-association` file to a pure PWA does not create that native app ([Apple Universal Links](https://developer.apple.com/documentation/Xcode/allowing-apps-and-websites-to-link-to-your-content)). Do not implement an ineffective redirect loop or pretend an `Open app` web button can force iOS to launch this PWA.

Current source manifest has `id`, `scope` and `start_url` all `/`, `display=standalone`. For production this includes paths under `https://app.dibs.fit/`, including app share/invite routes. `dibs.fit`, `dev.dibs.fit`, `experiment.dibs.fit` and the retired origin are different origins; the production manifest does not capture them. `id` establishes install identity; `start_url` establishes launch entry; neither forces external handoff. Keep canonical share links on the correct app origin. This is a researched answer, not an instruction to change manifest, association files, deployment or routing. Physical iOS/Android link-launch tests remain outstanding.

## Acceptance and handoff checks

Implementation must reproduce each affected baseline in real Chrome first, record its exact source/computed-style basis, implement, then recheck the same route. Baseline source plus screenshots is not an after-fix acceptance.

- Run the project's relevant tests under Node 22.23.4 with the test encryption configuration, then `npm test` and `npm run build:client`. Show actual output in the completion turn. Read `Documentation/TESTING.md` before adding tests. There is no app test result for this documentation-only design pass.
- Add meaningful pure aggregation cases: pre-Dibs history, more than 1,000 records, gym/event ID collisions, guest duplicates, empty event IDs, cancelled/no-show/unconfirmed, in-progress/future classes, zero-filled dates, DST, two gym timezones, consecutive ISO weeks across year change, current-empty-week grace, a missed full week, partial import and unlink. Prove private endpoint authorization and no new Team sharing leakage.
- Browser matrix: 320×568 and 390px light/dark; desktop; reduced motion; logo loading failure; continuous loop seam beyond two full cycles; persistent tap/keyboard pause; no visible Pause Logos button; optional setup with no saved spots, empty saved map, actual slots, return from editor, update failure and already-on legacy state.
- Teams: delayed successful list and zero-Team response, list refresh, failed fetch/retry, no empty-pitch flash, correct two-row copy, button spacing and above-fold availability at 320×568. Use app mock/fixture APIs with real Chrome, and clearly label any delayed/network-substituted scenario; never call a temporary DOM preview a real persisted state.
- Home: zero favourites in all gyms hides; a favourite with no next-seven-day match shows the true empty state; one failed gym is unknown; add/remove and unlink update visibility. Zero future bookings versus waitlist-only versus confirmed booking and fetch failure. Charts preserve per-gym failure/disabled coverage and never claim attendance or exact completeness without evidence.
- Preserve earlier refinements: Team selected-day tap closes its expansion; trophy icon; no visible duplicate instructor-period label; About tour/purpose/privacy order; setup's four cards and completed-card collapse; Auto-Upgrade default OFF; Calendar Settings stays available while its context action is limited to setup; name-inference provenance and completion-focus fallback.
- Final handoff contains exact changed-file diff, local test/browser output and screenshots. No deployment command, host access, registry edit, commit, push or merge is included in this request.
