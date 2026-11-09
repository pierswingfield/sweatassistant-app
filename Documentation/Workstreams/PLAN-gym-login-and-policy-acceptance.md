# Optional gym login storage and policy acceptance

Status: implemented and deployed to experiment only on `feat/optional-gym-login-policy` (uncommitted working tree based on `43592eb`). Owner requirements recorded 8 November and clarified 9 November 2026. Receipts: [local implementation and Chrome evidence](../QA/browser-runs/gym-login-policy-2026-11-09/README.md) and [experiment deployment and Chrome smoke](../QA/browser-runs/gym-login-policy-experiment-2026-11-09/README.md).
This plan covers account creation, About, first gym connection, gym reauthentication,
forgetting saved gym login details, session expiry and rejected saved credentials.

## Required experience

### Create an account and read the policies

- Add a required, initially unticked checkbox before Create Account, with links to
  **Terms and Conditions** and **Privacy Policy**. Proposed label: “I agree to the
  Terms and Conditions and acknowledge the Privacy Policy.” This distinguishes
  acceptance of the service terms from acknowledgement of the privacy information.
- Reading either document must preserve the signup form and checkbox state. Use
  accessible document pages available before login; do not require a Dibs account
  to read them. Links must not themselves toggle the checkbox.
- Validate acceptance on the server as well as in the form. Record accepted Terms
  version, acknowledged Privacy Policy version and server timestamp with the account.
  Reject missing acceptance or an obsolete version with a clear prompt to review.
- Add the same named links to Settings → About. Keep published versions available
  at stable URLs, with dates and accessible mobile layouts.
- Owner decision, 9 November: every existing account is a test account. No existing-account acceptance/consent migration UX is required; historical acceptance is not fabricated.
- Owner decision, 9 November: the existing Terms and Privacy wording is approved. Public, accessible policy pages and versioned copies are included in this branch. The optional-storage paragraph/table corrections are recorded in the receipt; no legal-compliance conclusion is made.

### Connect or log back into a gym

Every gym authentication surface must use the same control: onboarding, Add a gym,
Settings reauthentication and the Home reconnect action.

Checkbox label: **Remember your gym login**. Initially **unticked**, including on
reauthentication. Never silently carry forward a previous opt-in.

When unticked, show this owner-supplied text exactly:

> Dibs won’t save copies of your gym login details. You may be asked to log back in more often.

When ticked, replace it with this owner-supplied text exactly:

> Dibs will securely store copies of your gym login details, and use them on your behalf. More info can be found in the Terms and Conditions and Privacy Policy.

Link “Terms and Conditions” and “Privacy Policy” in that text. Add a short supporting
explanation in both modes: “Dibs stores an encrypted gym session to keep your
connection working. Auto-Book and Auto-Upgrade pause if you need to log in again.”
Session-only means no retained gym login email/password for reauthentication; it
does not mean no authentication secrets are stored. Provider-issued access tokens,
refresh tokens or necessary session cookies remain sensitive session data.

- Unticked: use submitted details only to authenticate, retain the resulting session,
  and discard login inputs. Do not persist an encrypted password or a separate
  reusable login email. Never fall back to the Dibs account email/password.
- Ticked: after successful authentication only, persist the gym login email and
  encrypted password for use on that user's behalf. Record the choice and disclosure
  version/time per gym. Failed authentication must not replace a working connection
  or record successful authorisation.
- A successful unticked reauthentication must remove any previously saved login
  details for that gym. The new session and storage choice must be committed together.
- Clear password inputs and transient request references after completion/cancel.
  Do not log or cache credentials in analytics, errors, browser storage or queues.
  Do not promise forensic erasure of JavaScript process memory.

### Forget a saved gym login

In that gym's Settings pane, offer **Forget gym login** when saved login details
exist and the session is working. Keep it separate from Disconnect gym. If the
session is already expired, also offer removal of saved login details with a clear
“Log in again” route; users must not be trapped into retaining rejected credentials.

Show a confirmation modal before removal, using the shared mobile modal navigation:

> Forget your saved gym login?
>
> Dibs will remove your saved gym login details and keep your current session.
> You’ll need to log in again occasionally. Auto-Book, Auto-Upgrade and syncing
> will pause for this gym when its session expires.

Actions: **Keep saved login** and **Forget gym login**. Confirming removes the saved
email/password and storage opt-in immediately, retaining the current session, gym
link, preferences, queues, history, sharing choices and calendar token. It does not
cancel provider bookings. Show “Session only” in the gym's connection settings.

Do not use `resetGymCredentials()` for this: it also clears sessions. Use a dedicated,
authenticated per-gym operation. Guard against in-flight automatic re-login saving
old credentials or replacing the session after removal; recheck storage permission
and a connection revision before committing any renewal.

## Connection lifecycle and recovery

| Situation | Required outcome |
|---|---|
| Session works, either storage choice | Sync and enabled automation continue normally. |
| Access token expires, session refresh works | Renew using provider session material; no user interruption. |
| Session cannot renew, saved login is permitted and works | Reauthenticate through the adapter and restore normal service. |
| Session cannot renew and no saved login exists | Mark this gym as requiring login, pause its automation and notify once. |
| Saved login is definitively rejected or revoked | Stop repeated credential attempts; mark this gym as requiring login and notify once. |
| Network failure, provider 5xx or rate limit | Apply outage/backoff handling; do not assume credentials changed or discard a potentially valid session. |
| User successfully logs in again | Restore this gym after fresh sync, clear its warning, and resume eligible work. |

Reuse `needs_relogin` and `GYM_SESSION_EXPIRED`, with a safe reason code for UI copy.
Provider adapters own expiry, refresh and rejection classification. No gym-specific
behaviour belongs in shared code. CodexFit currently needs a full login after expiry;
MarianaTek can refresh its session without a saved password. Do not promise fixed
session lifetimes or detect a changed password before the provider rejects access.

Use one server transition for foreground and background failures: gym state,
incident identifier, detection time, paused work and notification enqueue. Repeated
requests and concurrent workers must not generate duplicate incidents. If expiry is
known, check through the existing background scheduling/sync infrastructure; if it
is not known, detect it on the next safe provider operation. Do not add aggressive
login polling. Reconnection closes the incident so a later expiry can notify again.

### Notification and persistent warning

- Send a Web Push on the transition into requiring login, subject to browser push
  permission/subscription and notification preferences. Suggested copy: “Log in to
  {gym} again. Syncing, Auto-Book and Auto-Upgrade are paused for this gym.”
- The push action opens that gym's reauthentication flow after any required Dibs
  sign-in. Do not include login details or session tokens in the notification/URL.
- A notification delivery failure must not lose the incident. Persist the warning
  regardless of push availability; use existing retry practices and deduplicate.
- On app open, resume and connection-state changes, fetch current gym connection
  status. The UI must not depend on the user first making a failed gym request.
- Put a non-reorderable warning widget above normal Home widgets. List every gym
  requiring login, each with **Log in again**. Keep the warning until resolved;
  avoid a blocking modal on every visit. Settings retains an equivalent prompt.
- Reauthenticate one gym at a time with the remember checkbox unticked. Another
  gym's failure must never sign the user out of Dibs or interrupt healthy gyms.

## Graceful disappearance of gym data

Treat “disappears” as a reversible visibility and availability change, not unlinking
or deleting the user's saved setup. While login is required, exclude that gym from
normal operational features and show the warning as the explanation.

| Surface | Behaviour while gym login is required |
|---|---|
| Home widgets, credit badges, timetable and cross-gym views | Hide affected gym rows/values, recompute from available gyms, and explain missing data rather than showing misleading zero totals. |
| Bookings and waitlists | Hide stale actionable rows for that gym; explain they are unavailable until login. Remind the user that gym bookings still exist and can be managed directly with the gym. |
| Auto-Book and Auto-Upgrade | Preserve configuration/queue rows but pause provider work. Show a paused count/status in connection management, rather than pretending the queue is empty or running. |
| Favourites, history, personal statistics and Teams | Preserve stored data/settings; exclude the affected gym from ordinary displayed data and derived totals while reconnecting. Team membership itself survives. Apply this on server projections as well as in the owner's UI. |
| Calendar feeds | Exclude affected gym events while unavailable, retain feed tokens and healthy gyms' events. Explain that temporary removal from the feed does not cancel actual bookings; subscriber refresh timing is outside Dibs' control. |
| Gym Settings | Keep gym visible with status, storage mode, login action and connection controls. |
| Last available gym expires | Show a reconnect state, not “Connect your first gym”, account logout or an unexplained empty app. |

Use one shared per-gym availability policy, distinct from membership, gym enablement
and explicit user pause. Apply it consistently to API responses, background jobs,
Team projections, calendar generation and the client. Clear or suppress the affected
gym's IndexedDB/API/widget/memory caches; prevent late responses from repopulating
them. Old data must not reappear after a reload or during an offline open. Ensure
calendar and Team/statistic caches are invalidated too. This is a deliberate change
from retaining last-good rows for ordinary display; keep those rows only as internal
data pending reconnection.

After reauthentication, fetch fresh data before restoring dependent views. Resume
only still-valid automation: expired queue entries must not fire late; rerun normal
eligibility/window checks and preserve user pause/disabled choices and priorities.

## Implementation sequence and acceptance gates

Implementation is present locally; acceptance evidence and any limits are in the linked receipt. Follow [the agent protocol](AGENT_PROTOCOL.md) before code
changes and [testing guidance](../TESTING.md) before adding tests.

1. **Policy pages and account acceptance.** Finalise publication dependencies, add
   public pages, signup/About links, required checkbox and server version records.
   Verify reading/back navigation, keyboard labels, direct signup rejection without
   acceptance and successful creation with the correct versions.
2. **Per-gym storage choice.** Add explicit server-validated `rememberLogin` (only
   boolean true permits storage; missing defaults false), update every authentication
   entry point and add the forget operation. Verify live DB contains session material
   but no reusable login details in session-only mode, including raw profile/session
   fields that may echo login inputs. Stored profile contact data must be separately
   justified and disclosed, never secretly reused as a login identifier.
3. **Recovery state and notifications.** Centralise classified auth failure handling,
   deduplicated notification incidents and state retrieval on app open/resume. Test
   no stored login, rejected stored login, refresh success, provider outage, 429,
   absent push subscription and concurrent foreground/background failures.
4. **Feature availability and Home alert.** Implement the shared visibility rule,
   per-gym cache invalidation and reconnect UI. Verify every surface in the table,
   two gyms with one failing, all gyms failing, offline/reload, late responses and
   a successful reconnect without lost setup or changed sharing preferences.
5. **Release and existing accounts.** Reconcile the existing-account rollout choice
   below, run `npm test`, client build and real user-Chrome before/after checks.
   Exercise both provider refresh patterns locally without making real gym bookings
   or purchases. Provider-specific live reads follow the live-verification playbook.

### Existing test accounts and retention — owner decision recorded 9 November

The owner confirmed all existing accounts are test accounts and no existing-account consent or migration UX should be built. New connections default to session-only; automatic renewal requires the explicit stored permission flag. Existing account acceptance is left unset. No test-account database was deleted and no deployed data was changed. Deployment remains a separate task.

“Forget” removes active copies used by Dibs. Existing backups may retain historical
encrypted copies until expiry: align the policy text and retention process, and
ensure restore procedures reapply removal choices before enabling background work.
Audit redacted logs/profile caches for accidental retained inputs. Never advertise
instant removal from all historical backups unless that has actually been implemented.

## Baseline evidence and limits — 8 November 2026

Direct source checks:

- `server/auth.js`: `linkGymAccount()` always writes `gym_email` and an encrypted
  password after login. `triggerAutoRelogin()` already passes session/credentials
  to the adapter and flags `needs_relogin`; its broad catch currently clears the
  session even on failures that need finer classification.
- `server/providers/codexfit.js` and `marianatek.js`: `refreshSession()` owns the
  platform-specific renewal ladder; a missing saved password needs explicit
  handling in the no-refresh path.
- `server/db.js`: `user_gyms` has nullable credentials and session fields;
  `sealSession()` encrypts session storage. No schema recreation is authorised:
  use an additive, data-preserving migration for new state/acceptance fields.
- `client/src/api.js`: gym failure dispatches `app-gym-needs-relogin`.
  `client/src/main.js`: listener currently shows a toast and refreshes Settings,
  rather than providing the persistent launch-time Home warning specified here.
- `client/index.html`: signup has no acceptance checkbox; About describes storage
  but has no Terms/Privacy document links. Settings `openLinkGymModal()` has no
  remember checkbox; onboarding also calls `api.linkGym()` without a storage choice.
- `server/notifications.js`: defaults have no gym-login-required notification type.
  `server/booking-sync.js` skips `needs_relogin` links already.
- `server/team-data.js` selects link enablement without auth status and
  `server/team-projection.js` gates on enablement. Expiry-related hiding therefore
  needs explicit projection work rather than assuming sync pausing hides old rows.

Real Chrome CDP was reachable. In one owned tab per attempt, the local app at
`http://127.0.0.1:5174/` loaded the signup/About DOM; signup contained zero checkboxes.
However, the signup form was not visible and the rendered page remained effectively
blank after waiting. No successful visible signup, gym login or expired-session flow
was verified; those browser acceptance checks remain open. The owned tabs were
closed. No user login, provider write or remote deployment was performed.

Gemini provenance: two successful Flash locator calls, each followed by targeted
source checks. One additional call failed before inference because a guessed
`server/providers/session-manager.js` path does not exist; the corrected call used
the owning `server/auth.js`. No live-doc or legal research was performed for this
product plan. Existing legal review findings remain owned by their source document.

Documentation-only verification: relative Markdown links and required copy/task
coverage are checked in this change. No documentation-specific verify command is
declared; application tests/build are not claimed for this plan.

## Implementation receipt — 9 November 2026

Local changes include published policy pages/signup version recording, shared unticked gym-login disclosure, session-only/remembered storage and forget controls, revision-checked renewal, classified failure incidents and durable notification retry, per-gym availability across operational jobs, Teams, personal statistics and calendar, stale-response/cache retirement and persistent Home reconnect controls. Reconnection fetches fresh booking/waitlist data before restoring availability; release fences prevent missed Auto-Book entries firing late.

All verification outputs, initial failed runs, mutation evidence and real Chrome before/after screenshots are retained in the [receipt directory](../QA/browser-runs/gym-login-policy-2026-11-09/). No remote deployment or real gym write occurred. Original baseline evidence above is historical.

### Review correction receipt — 9 November 2026

The three Terra findings are corrected locally: rejected post-renewal sessions now use one deduplicated login-required transition in background poller/sync paths; retry rejection is fenced by the exact session token and connection revision (including the real scheduler worker); unavailable booked-cache rows are excluded from overlap projections along with unavailable queue rows. Focused worker verification passes 13/13 and the overlap HTTP regression passes. Real Chrome before/after request evidence and full verification outputs are recorded under the implementation receipt's **Terra review corrections** section. No deployment occurred.

Review-correction final verification: `review-full-tests.txt` records 124/124 server suites and 990/990 client tests passing; `review-build.txt` records a successful build with the existing chunk-size warning. Focused worker and overlap HTTP regressions pass, and real Chrome confirms the healthy conflict remains while the unavailable gym is omitted. Changes remain local and uncommitted.

### Auto-Upgrade retry recheck — 9 November 2026

A bounded review found two additional unchecked Auto-Upgrade mutation retries. Both are now guarded, and an exact audit brought all eleven post-renewal provider operations onto the shared single-operation guard. The existing attempt limit is unchanged; stale token/revision failures cannot invalidate a newer connection, and definitive rejection records one incident. The worker regression suite passes 29/29, including mutation-count and stale-response cases. Outputs are under the receipt's **Auto-Upgrade mutation retries** section. No UI code or deployment changed.

Auto-Upgrade retry recheck verification completed: 124/124 server suites and 990/990 client tests pass in `review-mutation-full-tests.txt`; the build passes in `review-mutation-build.txt`. The focused suite passes 29/29. No source changes followed those final checks.

### Policy contact browser defect — 9 November 2026

Before-fix real Chrome evidence confirms that Cloudflare rewrites plain policy email addresses into protected links. `client/src/ui/policies.js` fetches the document and imports only its `<main>` through DOMParser, so the deferred Cloudflare decoder never runs. Direct documents decode, but embedded readers display `[email protected]` and navigate to the protection endpoint. Origin files contain the correct address; this is not a stale service-worker response. Evidence: [email protection receipt](../QA/browser-runs/policy-email-protection-2026-11-09/README.md). Fixed and deployed to experiment only: policy-specific `Cache-Control: no-cache, no-transform`, with explicit readable `mailto:privacy@dibs.fit` links. Regression, 124 server suites, 990 client tests, build, health/data preservation and 16/16 real-Chrome checks pass; physical iPhone remains a follow-up.


### Choice polish and actual expiry delivery — 9 November 2026

Experiment-only completion: shared Dibs choice treatment preserves all consent/disclosure copy and opt-in semantics; onboarding logos fade out on gym selection with safe reversal, focus and reduced motion. The authorized test3 investigation found both original access tokens still accepted after provider password changes, plus an Aarmy refresh still valid. Forced rejection exposed shared MarianaTek plain-Error status loss and then a successful-renewal sync revision abort. Both are corrected: typed HTTP failure propagation and one bounded full-snapshot reread, retaining stale-write fences. Login-required bodies now independently name the configured gym.

[Verified receipt](../QA/browser-runs/choice-polish-notifications-2026-11-09/README.md): real-adapter regressions 7/7, notification naming 13/13, marquee behavior 4/4, final 125/125 server suites and 993/993 client tests; client build; 21/21 local Chrome, 3/3 Settings and 6/6 deployed Chrome; health/integrity/config/hash preservation. Apple accepted one push for each scoped link, with no duplicate on another sync; Both arrivals are owner-confirmed on iPhone; the owner also confirmed Aarmy appears correctly in its notification body. This confirms notification delivery, not agent-operated physical iPhone UI testing. Both links intentionally remain needs_relogin/session-only with sessions cleared and must be reconnected normally. No live gym write or production/dev/marketing deployment. The final server-only correction used the preserved local verified image after Docker Hub returned 429; exact provenance/rollback is in the receipt.

### Reconnect design sweep — 9 November 2026, verified basis

Real Chrome before captures show the reconnect warning using a separate orange-bordered style above Home’s normal cards. Psycle’s `needs_relogin` Settings pane renders six cards and the added paused/queue/calendar paragraph. The reauth submit is `position: sticky` inside the scrolling form; at a focused 390×420 visible viewport it overlays the Remember disclosure. Preserve the shared visual-viewport shell; make this form’s submit part of normal scrolling flow, use the existing Home widget/card hierarchy, and render only the connection card while reauthentication is required. Evidence: [before captures and checks](../QA/browser-runs/reconnect-design-sweep-2026-11-09/). Physical iPhone keyboard behavior has not been reproduced directly. At inspection, test3’s Aarmy connection is healthy and Psycle needs login; no diagnostic state changes are requested.

Verified and deployed to experiment on 9 November: registered Home connections card, removal of the noisy reconnect paragraph, connection-only Settings during relogin, and normal-flow gym-login submit. The final 320px visual pass also keeps the short login badge and full session label readable. Final source: 125 server suites / 996 client tests and build pass; 28 local + 20 deployed real-Chrome acceptance checks. [Receipt](../QA/browser-runs/reconnect-design-sweep-2026-11-09/README.md). Native iPhone keyboard/accessory-bar/safe-area behavior remains a focused physical check; no provider writes or push sends were made in this sweep.

### 9 November — Home supporting copy, Your Stats empty text removal and title separators

Verified before editing: Home invitation explicitly uses 17px/500, stats/trends empty text inherit 14px, Teams uses 13px. A scoped common compact body rule unifies supporting paragraphs while retaining headings/actions, and `"Your training story starts with your first past class."` is removed from the `Your stats` card when `totalPastClasses === 0` so only the `0 weeks` streak tile renders. Event 221582 read-only response has `LAGREE | Lagree & Free Shake (Signature 50)`; the shared cleaner removes the discipline plus whitespace and trims decorative leading pipes/spaced separators in both client and server mirrors while leaving provider titles unchanged. Verified with 125/125 server suites, 998/998 client tests, client build and 10/10 real-Chrome checks. [Receipt and captures](../QA/browser-runs/home-copy-class-names-2026-11-09/README.md).
