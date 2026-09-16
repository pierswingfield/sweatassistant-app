# Browser automation user-flow validation plan

## Purpose

This is an execution-ready QA plan for an agent using browser automation to test Sweat Assistant
across Psycle London and JAB Boxing Club. It covers complete user goals, cross-gym correctness,
visual and interaction quality, live-provider confirmation, defect reporting, and cleanup.

This is a **test and report** task. The executing agent must not change application code, data
outside the authorised test accounts, or project backlog statuses unless separately asked.

Read before running:

- [Project test layers](../TESTING.md)
- [Current multi-gym acceptance status](modular-gyms/OUTSTANDING.md)
- [Rules for any real provider request](modular-gyms/LIVE_VERIFICATION_PLAYBOOK.md)
- [Design system](../DESIGN.md)

## 1. Acceptance model

Use these result labels. Do not turn an incomplete check into a pass.

| Result | Meaning |
|---|---|
| `PASS` | The visible result, persisted state, and any required provider-side result were all verified. |
| `FAIL` | The observed result differs from the expected result or is internally inconsistent. |
| `BLOCKED` | A required credential, capability, class state, device permission, or environment is unavailable. |
| `DEFERRED` | The flow is deliberately waiting for a future release, native waitlist promotion, or other time-based precondition. |
| `NOT RUN` | The flow was not attempted. |

For any state-changing operation, report three checks separately:

1. **UI accepted it**: control state/toast/modal reflects success.
2. **Sweat Assistant persisted it**: refresh, logout/login, or a second view still shows it.
3. **Provider confirmed it**: the booking, waitlist, cancellation, or moved spot is visible in the
   gym's own website/app, where that confirmation is available.

A green toast alone is not a pass.

## 2. Test lanes and personas

Run the lanes in this order. Do not use a real account to discover basic UI bugs that mocks can
surface without risk.

### Lane A — local mocks

- Run the app locally with the existing Psycle and JAB mocks.
- Use `dev@psycle.com` with any password.
- Exercise destructive, boundary, double-click, offline, and error cases here first.
- Mock writes are safe, but still clean them up so later flows start from known state.

### Lane B — staging with real provider accounts

- Use a fresh/disposable Sweat Assistant account wherever possible.
- Link only gym accounts explicitly supplied for this QA run.
- Before the first live page load or request, obtain the session-specific authorisation required by
  `LIVE_VERIFICATION_PLAYBOOK.md`.
- Before each live write flow, obtain approval for that numbered flow ID. Approval for one flow is
  not approval for another.
- Never send direct requests to CodexFit or MarianaTek to bypass the UI. Read-only API inspection is
  allowed only when separately authorised and needed to explain a UI result.

### Required personas

| Persona | Purpose |
|---|---|
| `Fresh` | Newly created Sweat Assistant account with no gym linked. |
| `Psycle-only` | Single linked Psycle account; proves the single-gym regression path. |
| `JAB-only` | Single linked JAB account; proves membership, FCFS, native waitlist, and atomic swap behaviour. |
| `Multi-gym` | The same Sweat Assistant account linked to both gyms; proves merged views and gym isolation. |
| `Ineligible` | Account with no applicable credits/membership, if one is available; read-only eligibility checks only. |
| `Reconnect` | A staging-only link with a safely induced expired/invalid session, if the environment supports this. |

Personas may be produced sequentially from one disposable account, but take a baseline before every
transition and do not unlink a gym until all state belonging to it has been cleaned up.

## 3. Non-negotiable safety rules

### 3.1 Protected records

At the beginning of every live run, record every existing booking and waitlist item in a protected
baseline using a non-sensitive fingerprint:

`gym + provider booking/waitlist ID + class start + class name + spot label`

- Never click Edit, Cancel, Leave waitlist, or any destructive overflow action on a protected item.
- A booking or waitlist may be changed only when its provider ID is in the current run's
  `created_by_this_run` ledger.
- If a record cannot be unambiguously matched to the ledger, stop. Treat it as pre-existing.
- Existing bookings may be inspected read-only for rendering, sorting, gym labelling, and status.

### 3.2 Safe class selection

For every real booking, waitlist, Auto-Book, or Auto-Upgrade flow, select a class that satisfies all
of the following:

- starts at least **7 full days** after the current time, except for the narrowly defined Psycle
  Community-class exception below;
- is confirmed outside the provider's cancellation-penalty window;
- is not already booked or waitlisted in the pre-run baseline;
- is not a special event with a non-refundable or unusual policy;
- has enough time to clean up and verify restoration before the session ends;
- is clearly tied to the intended gym, studio, and provider.

Before booking, use the app's cancellation/penalty information where available. If the free-cancel
status is missing or ambiguous, do not book that class. A nearer class is not an acceptable
substitute just because it has convenient availability.

**Psycle Community-class exception:** a class may bypass the seven-day threshold only when the UI
or provider explicitly identifies it as a free/zero-credit Community class and confirms free
cancellation. It must still start **more than 12 hours** after the current time, be absent from the
protected baseline, and be explicitly authorised for the flow. Do not infer Community/free status
from a vague class name. If any part is ambiguous, keep the seven-day threshold or defer the write.

### 3.3 Prohibited actions

- Do not modify or cancel any booking that existed before the run.
- Do not join a waitlist for a class starting within 7 days, except for an explicitly verified
  free/zero-credit Psycle Community class more than 12 hours away under the exception above.
- Do not perform an inside-penalty cancellation. The read-only penalty display may be inspected;
  the actual cancellation remains out of scope unless the user explicitly authorises that exact
  cancellation because they already intended to cancel it.
- Do not purchase credits, start checkout, charge a saved card, test 3-D Secure, or change payment
  details.
- Do not delete a non-disposable account.
- Do not allow an Auto-Book to remain armed after the run unless it is a specifically authorised
  time-dependent test with an owner and cleanup deadline.
- Do not expose credentials, tokens, personal details, payment metadata, or presigned URLs in logs,
  screenshots, repo files, browser console copies, or issue reports.

### 3.4 Credential handling

- Use a dedicated, non-synchronised QA browser profile on the expected HTTPS staging hostname.
- The preferred handoff is **user entry into the visible Sweat Assistant gym-link form**. The
  orchestrator navigates to the form, verifies the hostname and named gym, pauses screenshots and
  network-body capture, and asks the user to type or password-manager-autofill the credentials.
- Do not provide a gym password in the Codex conversation, this Markdown file, `CONTROL.md`, an
  environment file, a shell command, a subagent prompt, or any run artefact.
- After submission, later subagents reuse the same authenticated browser profile/tab. They receive
  a browser/tab identifier, never the credential. A clean subagent means clean **model context**,
  not a new unauthenticated browser profile.
- For reauthentication, repeat the same pause-and-user-entry handoff. A subagent must never read a
  password input's DOM value, inspect the login request body, or copy browser storage.
- Disable screen/video capture while credentials are visible. Resume only after the password field
  is cleared and the result screen is visible.
- Crop or redact account email, name, membership identifier, tokens, and payment details from saved
  evidence.
- Prefer dedicated gym test accounts. If a personal gym account must be linked to staging, use a
  disposable Sweat Assistant account, unlink it or delete that disposable account after verified
  cleanup, and consider rotating the gym password afterwards if staging is not trusted to the same
  standard as production.
- Before credential entry, record one retention choice in `CONTROL.md`: `DELETE_DISPOSABLE_ACCOUNT`
  (recommended) or `KEEP_ENCRYPTED_STAGING_LINK` (requires the user's explicit choice). Never leave
  personal gym credentials stored on an ad-hoc staging account merely because the browser flow
  finished.

The application is designed to store gym passwords encrypted with AES-256-GCM and refuses to start
without an external `ENCRYPTION_KEY`; Sweat Assistant account passwords are separate from gym
credentials. These controls reduce exposure at rest, but they do not make a compromised browser,
host, staging database plus key, or over-privileged agent harmless. The operational rules above are
therefore mandatory.

### 3.5 Current Psycle live-booking constraint

The current Psycle test account has no paid credits.

- Mark paid Psycle booking, edit, cancellation, Auto-Book execution, and Auto-Upgrade execution as
  `DEFERRED`; do not enter checkout to unblock them.
- A Psycle live write may use a free Community class only when it is explicitly zero-credit/free,
  starts more than 12 hours away, confirms free cancellation, is absent from the protected
  baseline, and that exact flow is authorised.
- Do not infer that a class is free from its name alone. If the credit requirement or cancellation
  treatment is missing or ambiguous, keep the flow read-only and mark it `BLOCKED` or `DEFERRED`.
- Psycle booking-window, timetable, filter, capability, map, bookmark, settings, and rendering
  checks can still be completed without credits.
- Use local mocks for paid-Psycle mutation coverage and use the authorised JAB membership/test
  account for live core booking flows where appropriate.

### 3.6 Stop conditions

Stop the live run immediately on any of the following:

- wrong-gym mutation, wrong class, or unexpected modification of a protected record;
- cancellation penalty or irreversible-action warning on a test record that was expected to be
  freely reversible;
- provider `429`, new rate-limit headers, CAPTCHA/WAF page, unexplained `403`, or HTML where JSON
  was expected;
- any payment or purchase screen reached unexpectedly;
- inability to prove that a proposed destructive target was created by this run;
- cleanup failure that leaves a live booking, waitlist, queue entry, or upgrade monitor active.

Capture the state, stop further writes, and report to the user.

## 4. Run artefacts and evidence discipline

Create one run folder:

```text
Documentation/QA/browser-runs/YYYY-MM-DD-<environment>/
├── CONTROL.md
├── SUMMARY.md
├── RUN_LOG.md
├── ISSUES.md
└── screenshots/
```

Do not store raw authenticated network captures in the repository. Keep them in an ephemeral local
scratch location and save only sanitised excerpts or response shapes.

For every flow, add one row to `RUN_LOG.md`:

| Flow | Lane/persona | Browser/viewport/theme | Start/end | Result | Created IDs | Cleanup | Evidence | Issue IDs |
|---|---|---|---|---|---|---|---|---|

At meaningful checkpoints capture:

- full-page screenshot and a focused screenshot of the affected component;
- browser console errors/warnings introduced during the flow;
- failed or unexpected network request method, app-relative route, status, duration, and sanitised
  response shape;
- accessibility tree/role/name for controls that are hard to locate or label;
- before/after visible state;
- provider-side confirmation for live writes;
- exact cleanup state.

Use stable accessible roles, labels, and DOM IDs. Do not rely on screen coordinates when a semantic
selector exists.

## 5. Execution order and dependency map

```text
Gates and baseline
  -> account creation and first gym
  -> single-gym regression checks
  -> second gym and merged-view checks
  -> timetable and booking-window classification
  -> spot-map preferences
  -> safe live booking/waitlist writes
  -> Auto-Book and Auto-Upgrade
  -> resilience, PWA, notifications and calendar
  -> cleanup and reconciliation
```

Priority meanings:

- `P0`: safety, identity, wrong-gym/data-loss risk, or release blocker.
- `P1`: primary user goal or core multi-gym correctness.
- `P2`: important settings, resilience, installed/mobile, and feedback quality.
- `P3`: opportunistic or time-dependent acceptance.

## 5A. One clean subagent per flow

The root QA agent is an orchestrator. It must not accumulate every flow's browser details in one
large context. For each flow ID, it creates one fresh subagent with no inherited conversation
history (`fork_turns="none"` when that control is available) and a flow-specific prompt based on
the template below.

Rules:

1. Run one flow subagent at a time. The browser session, app database, ledgers, and live provider
   state are shared; parallel flow execution can duplicate writes or invalidate observations.
2. The orchestrator owns `CONTROL.md`. It records the active browser/tab identifier, sanitised
   protected baseline path, approved live flow IDs, created IDs, pending cleanup, changed settings,
   dependency results, and next permitted flow. It contains no credentials, tokens, request bodies,
   or personal data.
3. Before spawning a flow, the orchestrator checks dependencies and writes the minimum sanitised
   state the subagent needs to `CONTROL.md`.
4. Give the subagent the plan path, exact flow ID, lane/persona, environment label, browser/tab
   identifier, artefact paths, approval state, dependency facts, and explicit action boundary.
   Never forward the full parent conversation or any secret.
5. Each subagent executes exactly one flow, may not spawn another agent, may not fix code, and may
   not broaden its write scope. It updates only that flow's run-log/evidence/issue entries and any
   live IDs it creates.
6. If credential entry is needed, the subagent stops at the verified visible form and returns
   `NEEDS_USER_SECRET_ENTRY`. The orchestrator asks the user to type/autofill it, then resumes that
   same flow without copying the value into a message.
7. For live writes, the subagent rechecks approval, safe date, penalty state, protected IDs, and
   gym identity immediately before clicking. A prior subagent's assertion is not sufficient.
8. The orchestrator reviews the evidence and structured handoff before accepting the result or
   starting the next flow. Any created live ID must be in `CONTROL.md` before the child exits.
9. If a subagent fails or disappears after a live mutation, the orchestrator's next action is a
   dedicated clean cleanup subagent for the recorded ID, not the next functional flow.

### Flow-subagent prompt template

```text
You are the isolated browser-QA subagent for exactly one Sweat Assistant flow.

FLOW_ID: {{FLOW_ID}}
FLOW_TITLE: {{FLOW_TITLE}}
LANE: {{LOCAL_MOCK | STAGING_LIVE}}
PERSONA: {{Fresh | Psycle-only | JAB-only | Multi-gym | Ineligible | Reconnect}}
ENVIRONMENT_LABEL: {{label; do not include secrets}}
BROWSER_SESSION_OR_TAB: {{existing shared browser identifier}}
RUN_DIRECTORY: {{absolute path}}
CONTROL_FILE: {{absolute path to CONTROL.md}}
LIVE_APPROVAL: {{not required | approved exact flow ID | not approved}}
DEPENDENCIES: {{short sanitised facts and prerequisite flow results}}
ACTION_BOUNDARY: {{exactly what this flow may read/change}}

Read:
1. the global safety, evidence and subagent rules in
   Documentation/Backlog/browser-automation-user-flow-validation.md;
2. the detailed section for {{FLOW_ID}} only;
3. CONTROL.md;
4. any specifically linked source document required by that flow.

Do not read or inherit the parent conversation. Do not execute any other flow. Do not spawn another
agent. Do not modify application code or backlog status. Do not open a new browser profile; select
the existing shared QA browser/tab. Do not access password values, request bodies containing
credentials, browser storage, tokens, payment data, or unrelated personal information.

Before acting, verify the environment, persona, dependencies, action boundary, and approval. For a
live mutation, independently prove the target gym, permitted time threshold, free cancellation or
penalty status, and absence from the protected baseline. The default threshold is 7 full days. A
verified free/zero-credit Psycle Community class may instead be used when it starts more than 12
hours away and this exact flow is approved. Paid Psycle mutations are deferred.

If credentials are required, navigate only as far as the verified visible login/link form, disable
capture of sensitive fields/request bodies, and return NEEDS_USER_SECRET_ENTRY with the gym and
verified hostname. Never ask for the secret in chat or place it in a file/prompt.

Execute the flow steps. After each material action, inspect visible state, console, network metadata
without sensitive bodies, persisted state, the other gym for contamination, and provider-side state
where required. Write sanitised evidence to the run directory. Record any created live ID and
cleanup requirement in CONTROL.md immediately.

Return exactly this handoff:
RESULT: PASS | FAIL | BLOCKED | DEFERRED | NEEDS_USER_SECRET_ENTRY
FLOW_ID: ...
STEPS_COMPLETED: ...
EXPECTED: ...
ACTUAL: ...
CREATED_IDS: ...
PROTECTED_IDS_TOUCHED: none | STOP_AND_EXPLAIN
CLEANUP: complete | pending with exact ID/action | not applicable
EVIDENCE: ...
ISSUES: ...
CONSOLE_NETWORK: ...
PROVIDER_CONFIRMATION: confirmed | contradicted | unavailable | not applicable
NEXT_SAFE_ACTION: ...
```

## 6. Detailed flows

### Phase 0 — gates, baseline, and instrumentation

#### `GATE-01` — establish the environment and consent (`P0`)

1. Read the four documents linked at the top of this plan and the workspace `AGENTS.md`.
2. Record the app URL, environment, build/version stamp, current commit, worktree state, browser
   version, OS, timezone, viewport, colour scheme, and whether this is mock or live.
3. For local Lane A, select Node 20.19.0 from `.nvmrc`, run `npm test`, and run
   `npm run build:client`. Record the actual output; failures are findings.
4. Start the local app with `npm run dev` and verify both server and client respond before opening
   the browser.
5. For Lane B, verify the exact HTTPS staging hostname, expected certificate, build/version stamp,
   and access-control boundary before asking the user to enter any credential.
6. For Lane B, present the planned live read/write flow IDs and obtain explicit approval before any
   real provider traffic. Record which IDs were approved without recording credentials.
7. Verify that purchase/payment, penalty cancellation, pre-existing-record modification, and
   near-term classes are excluded.

Expected: environment is unambiguous, approval scope is recorded, and no live interaction has
occurred before the gate.

#### `GATE-02` — create the protected baseline and cleanup ledger (`P0`, live only)

1. Log in through the dedicated QA browser profile, using the user-entry credential handoff where
   needed, without opening destructive menus.
2. Record current linked gyms, settings relevant to this run, notification/push/calendar state,
   spot-map preferences, Auto-Book entries, Auto-Upgrade monitors, bookings, and waitlists.
3. Mark all pre-existing booking and waitlist fingerprints as protected.
4. Create empty ledgers for `created_by_this_run`, `settings_changed`, `maps_changed`, and
   `cleanup_pending`.
5. Capture sanitised screenshots of each baseline list.
6. Confirm the selected gym accounts contain no unexpected near-term state that could be confused
   with the run.

Expected: every future destructive action can be checked against a run-created ID and every setting
can be restored.

#### `GATE-03` — browser diagnostics (`P0`)

1. Open the browser console and network inspection available to the automation tool.
2. Clear old console entries, then reload once.
3. Record uncaught errors, rejected requests, mixed-content/security warnings, duplicate requests,
   and requests routed to the wrong gym.
4. Verify the initial loading skeleton resolves rather than sticking, flashing an empty state, or
   replacing fresh data with stale cached data.
5. Keep console/network collection active for every later flow; checkpoint after each phase.

Expected: the run starts from a clean diagnostic boundary. A clean console does not override a
visible data/copy defect.

### Phase 1 — account lifecycle and gym authentication

#### `AUTH-01` — signup validation and fresh no-gym account (`P0`, `Fresh` persona)

1. Open Create account from the login screen.
2. Submit empty fields; verify inline required-field feedback and no network mutation.
3. Enter an invalid email; verify it is rejected accessibly.
4. Enter mismatched passwords; verify the mismatch is explained and focus moves sensibly.
5. Enter the disposable account details and submit once.
6. Verify the account is created, the user is authenticated, and the app shows a legitimate
   no-gym/Connect a gym state rather than a login loop or generic error.
7. Refresh the page and verify the no-gym state persists.
8. Check that timetable, bookings, Auto-Book, credits/membership, and settings do not leak mock,
   previous-user, or default-Psycle data.

Expected: signup creates a Sweat Assistant identity independent of any gym. Gym-scoped reads should
be empty/actionable, not `401` loops.

#### `AUTH-02` — first gym link and onboarding (`P0`, `Psycle-only` or `JAB-only`; depends on `AUTH-01`)

1. Start Connect a gym from the no-gym state.
2. Verify only enabled/unlinked gyms are selectable.
3. Try an invalid gym email/password combination; verify no link is created and the message names
   the failing gym without leaking provider internals.
4. Link the authorised first gym with valid credentials.
5. Complete each onboarding step: intro, install guidance, gym login/link, notifications decision,
   calendar decision, and spot-map guidance. Use Skip/Back where offered and verify progress is
   coherent.
6. Verify the linked gym shows Connected plus last-authenticated information.
7. Verify timetable, membership/credits, bookings, waitlists, and gym settings all belong only to
   that gym.
8. Refresh and log out/in once to prove the link persists.

Expected: linking a gym does not change the Sweat Assistant login identity. Onboarding never blocks
the usable app if an optional permission is declined.

#### `AUTH-03` — login, logout, and session separation (`P0`)

1. Log out from Settings > Account.
2. Verify authenticated data disappears and Back/refresh cannot reveal the prior user's cached
   bookings, maps, credits, or account email.
3. Attempt login with a wrong Sweat Assistant password; verify failure without trying gym
   credentials as a fallback.
4. Log in with the correct Sweat Assistant password.
5. Verify the same linked gyms return without re-entering gym passwords.
6. Open all five main tabs and verify no stale state from a different persona appears.

Expected: account authentication is local and independent; logout clears visible sensitive state.

#### `AUTH-03R` — forgotten-password boundary (`P1`, read-only)

1. From the login screen, open Forgot password.
2. Verify the screen immediately and accurately explains that self-service recovery is unavailable
   and that recovery is admin-assisted.
3. Enter a test email and continue if the UI offers the control.
4. Verify the app does not ask for or accept a linked gym password as an account-recovery factor,
   does not imply that gym membership controls account ownership, and does not reveal whether an
   arbitrary email has an account.
5. Return to login and verify the normal sign-in form is restored without stale recovery state.

Expected: no self-service flow silently re-couples the Sweat Assistant account to a gym credential.
Report any contradictory subtitle, dormant gym-login step, or misleading promise as a copy/security
inconsistency.

#### `AUTH-04` — account password change (`P1`, disposable account only)

1. Open Settings > Account > Change account password.
2. Try an incorrect current password and a mismatched/invalid new password.
3. Change to a temporary new test password and record only that a secret changed, never the value.
4. Log out; verify the old password fails and the new password succeeds.
5. Verify gym links and provider sessions survived the account-password change.
6. Restore the baseline account password if required by the test owner and verify again.

Expected: changing the account password neither reauthenticates nor unlinks a gym.

#### `AUTH-05` — add a second gym and reject duplicates (`P0`, `Multi-gym` persona)

1. Open Settings > Your Gyms and select Connect a gym.
2. Verify an already linked gym is not offered as addable.
3. Link the other authorised gym.
4. Verify both gym rows show the correct gym-specific email and connection health.
5. Confirm there is no user-facing active-gym switcher; the product should present one merged
   timetable/bookings experience.
6. Refresh and revisit every main tab.
7. Verify each gym's membership/credit summary, settings, capability controls, theme markers, and
   data remain distinct.

Expected: adding a gym augments the account; it does not replace the first gym or silently choose
one as the visible gym.

#### `AUTH-06` — re-authenticate a healthy gym (`P1`)

1. From Your Gyms, choose Re-authenticate on one gym.
2. Submit wrong credentials and verify the existing healthy link/data are not destroyed.
3. Submit the valid current gym credentials.
4. Verify Connected state and last-authenticated time update for that gym only.
5. Confirm the other gym's session, data, preferences, and lists are unchanged.

Expected: failed reauthentication is non-destructive; successful reauthentication is gym-scoped.

#### `AUTH-07` — expired-session recovery (`P0`, staging-controlled `Reconnect` persona only)

1. Use an approved staging mechanism to invalidate one gym session without changing the provider
   password or touching the other link. Do not induce this on production by guesswork.
2. Trigger a read for the affected gym.
3. Verify either automatic provider-session renewal succeeds or the affected gym is marked
   Reconnect needed with a clear action.
4. Verify the unaffected gym continues to load and is not logged out or blanked.
5. Re-authenticate only the affected gym and verify recovery after refresh.

Expected: one provider failure degrades one gym, not the whole account.

#### `AUTH-08` — unlink and relink a gym (`P0`, disposable account; after cleanup for that gym)

1. Assert that the target gym has no run-created booking, waitlist, Auto-Book entry, or Auto-Upgrade
   monitor and that all map/settings changes are recorded for restoration.
2. Click Unlink once; verify the control changes to a timed confirmation and no mutation occurs.
3. Let confirmation expire once and verify it resets.
4. Click twice within the confirmation window.
5. Verify only that gym disappears from merged views and its sidebar/settings section is removed.
6. Verify the Sweat Assistant account and the other gym remain usable.
7. If this leaves zero gyms, verify the no-gym Connect a gym state and no login loop.
8. Relink the gym with valid credentials and verify its gym identity is correct.

Expected: unlink is deliberate, gym-scoped, and never deletes the account. Do not assume queues or
preferences survive or are deleted; record actual behaviour and compare it with the visible copy.

### Phase 2 — shell, responsive behaviour, settings, and non-booking goals

#### `SHELL-01` — navigation, refresh, and history (`P1`)

1. Visit Timetable, Bookings, Auto-Book, Credits & Membership, and Settings in order.
2. On every tab, verify heading, selected nav state, refresh control, loading state, empty state,
   and error state are specific to that tab.
3. Use each tab's refresh once; verify it does not jump tabs, reset unrelated filters, duplicate
   cards, or show stale data after fresh data.
4. Use browser Back/Forward and reload on each tab if URL/history state supports it.
5. Repeat using the mobile bottom navigation at 390x844 or an equivalent narrow viewport.

Expected: desktop and mobile expose the same information and actions with no hidden/duplicated nav.

#### `SHELL-02` — theme, responsive, keyboard, and visual-system sweep (`P1`)

For one representative state from each main tab, repeat in light and dark themes at desktop,
tablet, and narrow mobile widths.

1. Inspect horizontal overflow, clipped text, overlapping status/action columns, sticky headers,
   bottom-nav obstruction, safe-area spacing, scroll traps, modal height, and disabled controls.
2. Tab through all interactive controls; verify visible focus, logical focus order, operable menus,
   Escape/close behaviour, and focus restoration after closing a modal.
3. Verify ordinary controls target at least 44x44 CSS pixels where the design system requires it.
4. Verify meaningful text is not below the 12px design floor, statuses are not colour-only, and
   every icon-only action has an accessible name/tooltip.
5. Check reduced-motion mode if the automation environment supports it.
6. Confirm Psycle identity is violet and JAB identity navy only on gym-identifying elements; the
   shared Sweat Assistant chrome must not repaint as the selected/last-used gym.

Expected: the same task remains legible and reachable in every supported layout and theme.

#### `SET-01` — settings information architecture and scope (`P1`, multi-gym)

1. Visit General, Notifications, Account, Your Gyms, each gym's nested settings section, and About.
2. Verify each section has one clear purpose and no stale drawer/backdrop obscures a child modal.
3. Change one account-scoped setting such as theme and verify it applies across gyms.
4. Change Timetable Prefetch Range to 1 week and then 8 weeks; verify the saved selection and
   request range change without duplicated rows or a frozen UI, then restore the baseline.
5. Change one safe per-gym setting and verify only that gym's section changes.
6. Replay onboarding from the Welcome Tour card; verify the completed user can exit without losing
   settings or being forced to relink a gym.
7. Reload and verify persistence; log out/in and verify again.
8. Restore baseline values and verify restoration.
9. Inspect About copy for gym neutrality: it must not describe a JAB user as a Psycle/CodexFit
   user or imply that every Auto-Book opens Monday noon.

Expected: account settings are shared; gym settings are isolated; copy matches the multi-gym model.

#### `SET-02` — credits, membership, and capability gating (`P0`, read-only)

1. Open Credits & Membership with Psycle-only, JAB-only, and multi-gym personas.
2. Verify one summary per linked gym with correct name, membership/allowance state, and gym colour.
3. Verify Psycle exposes purchase/bundle browsing only when capability and eligibility allow it.
4. Verify JAB never displays Buy Credits, Stripe checkout, credit-shortage arithmetic, or a zero
   balance when the model is unmetered membership.
5. For the `Ineligible` persona, verify the provider-specific eligibility explanation is clear and no
   actionable booking control is shown falsely.
6. Search/filter Psycle bundles without selecting a purchasable item. Do not initiate checkout.
7. Cross-check class-level credit requirements against the action shown on representative Psycle
   rows, including a class costing more than one credit if available.

Expected: purchase controls and credit arithmetic are capability-driven per row/gym.

#### `SET-03` — export/import configuration (`P2`, mocks or disposable account)

1. Export the config JSON and save it outside the repository while inspecting it for secrets/PII.
2. Verify it contains intended preferences but no plaintext gym password, access token, refresh
   token, payment data, or unrelated account data.
3. Change one harmless setting and one mock spot preference.
4. Import the previously exported config.
5. Verify the supported settings are restored and unsupported/unknown fields do not break the app.
6. Test malformed JSON and the wrong file type; verify safe, actionable errors.
7. Restore the baseline and remove the local export after the run.

Expected: backup/migration is safe, bounded, and does not act as a credential export.

#### `SET-04` — profile explorer and provider-specific profile controls (`P2`, read-first)

1. Open each gym's Profile Explorer if capability-gated as supported.
2. Verify labels and values belong to that gym and are not mixed with the other provider.
3. Verify unsupported edit controls are absent rather than failing after click.
4. Do not save real profile changes unless the user separately authorises exact fields.
5. Close and reopen the modal; verify no data from the previous gym remains.

Expected: provider-specific surfaces remain gym-scoped and unsupported capabilities stay hidden.

#### `SET-05` — debug mode and diagnostics (`P2`, mock or disposable account)

1. Enable Debug Mode and verify the debug terminal/actions appear without covering navigation or
   essential controls.
2. Open class diagnostics for one Psycle and one JAB row; verify each names the correct gym and
   normalized class while raw provider data remains clearly separated.
3. Inspect displayed/logged diagnostics for passwords, bearer/refresh tokens, payment metadata,
   personal fields, or presigned URLs. Treat any exposure as P0 and do not save the raw evidence.
4. Use Simulate Release only with local mocks. Verify it cannot be triggered accidentally in a live
   environment and that one simulated result does not mutate the other gym.
5. Clear/collapse the debug terminal, disable Debug Mode, reload, and verify diagnostics are hidden.

Expected: debug tooling is useful and gym-scoped without exposing secrets or enabling unsafe live
mutations.

### Phase 3 — timetable discovery, filtering, and state classification

#### `TT-01` — merged timetable and chronological navigation (`P0`, multi-gym)

1. Load the current date range and wait for both gym fetches to settle.
2. Verify rows/cards from both gyms are in chronological order, not grouped accidentally by
   provider response order.
3. Verify every row has the correct gym text/logo/colour, class type, class name, instructor,
   location, studio, time, duration, occupancy, release state, and action.
4. Navigate forward across weekdays and a weekend, then back to today.
5. Exercise any week/date jump, Today control, and pull-to-refresh.
6. Refresh from warm cache and verify cached rows are not replaced with another gym's data.
7. Compare a sample from each gym with that gym's own public/member timetable.

Expected: one ordered view contains both gyms; every row remains self-identifying and correctly
routed.

#### `TT-02` — filters, collisions, reset, and persistence (`P1`)

1. Record unfiltered row counts per gym.
2. Apply gym filters: Psycle only, JAB only, both, and no selection if allowed.
3. Apply Location, Class type/discipline, Instructor, Time of day, and Availability filters one at
   a time; record selected value and resulting counts.
4. Verify location/instructor options are grouped or disambiguated by gym where names collide.
5. Combine gym + location + class type + instructor + availability to reach a small known set.
6. Create a valid zero-result combination and inspect the empty state and Clear filters action.
7. Clear one filter at a time, then Reset all.
8. Reload/log out and back in to verify documented filter persistence without leaking provider IDs
   into the other gym.
9. Repeat on mobile, including opening/closing the filter sheet and scrolling its full contents.

Expected: every filter narrows the visible normalized data correctly and never creates ghost rows
or an empty option list from string/number ID mismatches.

#### `TT-03` — tooltips, occupancy, images, and row actions (`P1`)

1. Hover and keyboard-focus instructor and occupancy affordances on desktop.
2. Tap to open/close them on touch/mobile; tap outside and press Escape.
3. Verify instructor thumbnail, full image, name, bio, Instagram/Spotify links, and fallbacks do not
   shift row layout or expose broken-image chrome.
4. Verify occupancy numbers/pills match the provider state and never overlap action buttons.
5. Inspect a Psycle and JAB row in each action state available: Auto-Book/Scheduled, Quick Book,
   Booked/Edit, Join Waitlist/Leave WL, Full, and Buy Credits/ineligible.
6. Verify the same class has equivalent primary/overflow actions on desktop and mobile.

Expected: visible state, accessible label, overflow menu, and underlying class all agree.

#### `TT-04` — per-row capability and wrong-gym routing matrix (`P0`, multi-gym)

1. With both gyms visible, pick alternating Psycle and JAB rows without changing any global state.
2. Open class details/spot maps for each and verify the correct provider's studio and spots load.
3. Confirm JAB maximum one spot, native waitlist, atomic swap, unmetered membership, and no purchase
   controls wherever those capabilities apply.
4. Confirm Psycle multi-spot where credits allow, app-managed waitlist, non-atomic spot change,
   metered credits, bookmarks, and purchase controls where applicable.
5. Inspect browser requests and verify every per-row read/write carries the row's gym identity.
6. Deliberately use classes/studios with equal-looking provider IDs or names when fixtures allow;
   verify details, instructor, map, preferences, and action state do not cross-contaminate.

Expected: the row's gym, not any persisted/default/ambient gym, determines every action.

#### `TT-05` — Psycle bookmarks and Auto-Book Favourites (`P2`)

1. On a Psycle row, toggle the bookmark/heart and verify the state persists after refresh and
   logout/login.
2. Verify JAB rows do not expose a bookmark action when the provider capability is unsupported.
3. Open Auto-Book Favourites and verify the bookmarked class appears with the correct time,
   instructor, studio, and Psycle identity.
4. Enable and disable the favourite and verify settings persistence without creating a queue entry
   or booking unexpectedly.
5. Confirm the UI does not promise unattended recurring scheduling that the current scheduler does
   not yet consume; if it does, report the known implementation gap with fresh evidence.
6. Restore the original bookmark/favourite state.

Expected: bookmarks are capability-gated and gym-scoped; favourites never imply an action that was
not actually scheduled.

### Phase 4 — booking-window boundaries

#### `WIN-01` — Psycle rolling-weekly window (`P0`)

1. Record the account's detected Psycle booking-window offset/source from the UI or authorised
   diagnostics. Do not infer the member tier from a hardcoded name table.
2. Find a Psycle class safely in the future whose release is still closed and record `startAt` and
   server-supplied `releaseAt`.
3. Verify the release is Monday 12:00 Europe/London and the class is unavailable for immediate
   booking but available for Auto-Book.
4. Find an otherwise comparable safe class just inside the open window and verify Quick Book is
   available.
5. Specifically inspect Tuesday alignment for a standard-offset fixture: base release uses
   Monday + 15 days, not +14. For a real member with an extended cutoff, verify the profile-derived
   offset is used verbatim and remains clamped to the documented safe range.
6. Check a class immediately before and after a DST transition when fixture data allows.
7. Verify no JAB release rule or countdown changes while performing Psycle checks.

Expected: every Psycle class in a weekly cohort shares the correct Monday noon release for that
member, while tier extensions are measured in days rather than rounded to weeks.

#### `WIN-02` — JAB per-class/continuous window (`P0`)

1. Find two JAB classes on the same date at different times near the membership boundary.
2. Record each provider-published `booking_start_datetime`/normalized `releaseAt`.
3. Verify each row counts down to its own instant rather than Monday noon or one shared daily time.
4. Where timing permits, verify an earlier class is open while a later class on the same date is
   still closed, matching an exact-to-the-minute 14-day fallback only when the published release is
   absent.
5. Verify the Auto-Book banner counts down to the soonest queued future release, while each card
   retains its own countdown.
6. Verify JAB does not show a weekly booking-window reminder by default.

Expected: published per-class release data wins; fallback calculation never overrides it.

#### `WIN-03` — deterministic edge boundaries (`P0`, local mock/synthetic time only)

For each window kind, run the browser with controlled fixture time at `releaseAt - 1 second`,
`releaseAt`, and `releaseAt + 1 second`.

1. At `-1s`, verify the immediate booking action is absent and Auto-Book is available.
2. At exactly the release, verify the action transitions once, countdown reaches zero without
   becoming negative/stuck, and no duplicate request fires.
3. At `+1s`, verify Quick Book/bookability is stable after reload.
4. Simulate a missing/invalid `releaseAt`; verify the scheduler/UI fail closed, show an actionable
   unknown state, and do not assume the class is open now.
5. Test an `alwaysBookable` Psycle fixture and verify it bypasses the normal window without changing
   other classes.

Expected: no early fire, no one-week slip, no negative countdown, and no missing-release default to
"now".

#### `WIN-04` — entitlement and window independence (`P1`)

1. Compare a bookable-window-but-ineligible class with an eligible-but-window-closed class.
2. Verify their actions and explanations differ correctly: entitlement and time are separate facts.
3. On Psycle, verify guest-only credits do not make a member class bookable.
4. On JAB, verify membership eligibility never becomes "0 credits".
5. Verify one gym's detected offset/eligibility does not affect the other gym's rows, queue, or
   settings copy.

Expected: timing, eligibility, credits, and membership are not conflated.

### Phase 5 — preferred spot maps

#### `MAP-01` — studio coverage and first-time map creation (`P1`)

Cover as many real/fixture studio shapes as available:

- Psycle Ride/bikes;
- Psycle Barre, Strength, Yoga, Reformer, or another differently shaped studio;
- JAB Boxing with Bag/Ground spot types;
- JAB TRAIN or another mapped class;
- JAB Recovery or another first-come-first-serve/no-map class.

For each mapped studio:

1. Open Settings > the correct gym > Manage Spot Maps.
2. Verify studio name/location/gym identity and spot noun/labels.
3. Select multiple ranked preferred spots/rows in a nontrivial order.
4. Toggle "book any if preferred unavailable" where offered.
5. Save, close, reopen, and verify exact order and fallback state.
6. Verify priority badges supplement rather than replace spot labels and long labels do not wrap
   illegibly inside small spots.
7. Record overflow, offscreen Save, meaningless whole-row `+` controls, cramped row gaps, or map
   scrolling that moves the modal instead of the map.

Expected: a saved preference is explicit, ordered, legible, and studio/gym-scoped.

#### `MAP-02` — edit once, propagate everywhere (`P0`)

1. Snapshot a run-created/disposable studio preference.
2. Open it from Settings and change the priority order.
3. Open Configure Quick-Book from a timetable row for that studio; verify the same order.
4. Open Configure Auto-Book for that studio; verify the same order.
5. If a run-created booking exists, open Auto-Upgrade and verify the same map.
6. Edit from one of those entry points, save, and recheck the other three without clearing caches.
7. Restore the baseline map or remove the disposable preference.

Expected: one shared preferred map drives Quick Book, Auto-Book, and Auto-Upgrade.

#### `MAP-03` — cross-gym and same-name isolation (`P0`, multi-gym)

1. Pick studios with the same/similar name or colliding fixture IDs across gyms where available.
2. Save a distinctive preference order for gym A.
3. Open gym B's studio and verify it has no inherited selection.
4. Save a different order for gym B.
5. Alternate between timetable, settings, and booking modals without logging out.
6. Verify each map remains attached to its own `gymId:studioId` and each save request targets the
   displayed gym.

Expected: no map, instructor, event, or spot preference crosses gym boundaries.

#### `MAP-04` — first-come-first-serve and unavailable maps (`P1`)

1. Open a JAB Recovery/FCFS row and another class whose metadata explicitly says no layout.
2. Verify Quick Book can be offered without a picker, but Configure spot map/Edit spot is absent.
3. Verify My Bookings does not show a misleading `Spot ?`; if it does, record the known defect with
   current evidence rather than treating it as an unknown provider failure.
4. For an unknown/bare studio metadata fixture, open the optimistic picker path and verify the modal
   self-corrects to a useful no-map state if no layout exists.

Expected: "no assigned spot" is a supported class model, not presented as missing/corrupt data.

### Phase 6 — live booking and cancellation flows

All live flows in this phase require the safe-class rule, explicit per-flow approval, and a ledger
assertion immediately before every mutation.

#### `BOOK-01` — regular booking with chosen spot (`P0`, approved live write)

1. For live Psycle, proceed only with an explicitly zero-credit/free Community class more than 12
   hours away; otherwise mark this flow `DEFERRED` and cover it with mocks. Select a safe, open,
   unbooked mapped class and record gym/event/start/studio/available spots,
   credit or membership state, and cancellation status.
2. Use the overflow action Book (choose a spot), not Quick Book.
3. Select a currently available spot and verify the selection summary.
4. Submit once and capture UI, app request, and returned booking ID.
5. Add the ID to `created_by_this_run` before doing anything else.
6. Verify the timetable row changes to Booked/Edit, My Bookings contains the correct gym/class/spot,
   allowance changes only if the gym is metered, and the gym's own system shows the same booking.
7. Refresh and log out/in to verify persistence.
8. Execute `BOOK-06` cleanup for this exact ID.

#### `BOOK-02` — Quick Book with preferences (`P0`, approved live write)

1. For live Psycle, proceed only with an explicitly zero-credit/free Community class more than 12
   hours away; otherwise mark this flow `DEFERRED` and cover it with mocks. Select another safe
   mapped class in a studio with a run-controlled preferred map.
2. Ensure at least one preferred spot is visibly available and record the ranked order.
3. Click Quick Book once; do not double-click while pending.
4. Record the returned booking ID immediately.
5. Verify the highest available preferred spot was chosen, or the documented fallback was used.
6. Verify any default Auto-Upgrade option matches account/gym settings and does not create a
   monitor unexpectedly.
7. Confirm in My Bookings and the provider's own system, then clean up with `BOOK-06`.

#### `BOOK-03` — Quick Book for FCFS/no-map class (`P1`, approved live write)

1. Select a safe JAB FCFS class with no seat map and confirm free cancellation.
2. Click Quick Book and record the booking ID.
3. Verify no empty map flashes, no invented spot is required, and the booking renders as booked
   without `Spot ?` ambiguity.
4. Verify it in JAB's own system and clean up with `BOOK-06`.

#### `BOOK-04` — per-gym quantity limits (`P1`; mock first, live only if safely eligible)

1. In mock Psycle, choose two spots in one class where allowance permits; verify both appear in the
   summary and grouped booking card.
2. Verify multi-spot management routes to My Bookings and does not offer a misleading single-record
   cancel from the timetable.
3. In JAB, attempt to select a second spot before submission; verify the first is replaced or the
   second is rejected because max spots is one.
4. Do not manufacture multiple live bookings merely to test a limit; live verification is optional
   and requires separate approval.
5. Clean up every mock/live ID created.

#### `BOOK-05` — edit booked spot (`P0`, run-created booking only)

1. Use a safe booking created by this run and reassert its ID is not protected.
2. Open Edit from My Bookings and verify the current spot is preselected.
3. Pick a different available spot and save.
4. For JAB, verify one atomic `swap_spots` operation and no temporary cancellation/disappearance.
5. For Psycle, explicitly observe and report the cancel-then-rebook risk/result; verify the new
   booking ID is captured and the ledger replaces the old ID before any cleanup.
6. Verify allowance, My Bookings, timetable, preferred map, and provider system remain consistent.
7. Clean up the current booking ID with `BOOK-06`.

Expected: capability routing is per booking's gym. A JAB swap must never take the Psycle
cancel/rebook path.

#### `BOOK-06` — cancel a booking created by this run (`P0`, mandatory cleanup)

1. Assert the target booking ID exists in `created_by_this_run` and the UI/provider reports free
   cancellation. Its class must be at least 7 days away, or more than 12 hours away when it is an
   explicitly verified free/zero-credit Psycle Community class.
2. If an Auto-Upgrade monitor exists for it, remove/disable the monitor first and verify removal.
3. If the visible post-booking grace period is still active, cancel immediately with the documented
   one-click grace behaviour; do not keep a live booking merely to wait out the grace timer.
4. Otherwise, click Cancel once, verify a second-click confirmation appears, allow it to expire
   once without cancelling, then repeat and confirm. The confirmation-expiry branch may be covered
   with mocks if delaying live cleanup would add risk.
5. Verify the booking disappears from My Bookings and timetable state, the provider's own system no
   longer shows it, and Psycle allowance is restored where applicable.
6. Verify no unrelated grouped spot or other-gym booking changed.
7. Mark the ledger item cleaned only after provider confirmation.

#### `BOOK-07` — duplicate submission and interrupted response (`P1`, local mocks only)

1. Throttle the network or use a controlled delayed response.
2. Double-click Book/Quick Book and verify controls disable and only one mutation occurs.
3. Reload while the result is pending; verify reconciliation shows one definitive state.
4. Simulate a provider error and verify no optimistic ghost booking remains.
5. Test retry after a failed request and verify the retry is deliberate, not automatic duplication.

Expected: uncertain transport does not create duplicate bookings or contradictory success/error
toasts.

### Phase 7 — waitlists

#### `WL-01` — join and leave waitlist (`P0`, approved live write)

1. Select a full, waitlist-enabled class at least 7 days away and not in the protected baseline. A
   verified free/zero-credit Psycle Community class may instead be more than 12 hours away when
   free cancellation/waitlist exit is confirmed.
2. Verify Join Waitlist is shown only for the row's gym/capability.
3. Join once, record the waitlist/provider ID, and add it to the ledger.
4. Verify the row becomes Leave WL/On Waitlist, My Bookings > Waitlists shows correct gym/class/time,
   and the provider system confirms it.
5. Reload and log out/in once.
6. Click Leave WL once and verify timed/two-click confirmation without mutation.
7. Confirm the second click; verify removal from UI and provider system.
8. Mark cleanup complete only after external confirmation.

#### `WL-02` — unavailable waitlist states (`P1`, mock/read-only live)

1. Inspect a full class with no waitlist capability and verify Full is disabled rather than Join.
2. Inspect an already-waitlisted protected item read-only and verify no duplicate Join action.
3. Simulate a stale row where the final space/waitlist disappears before submit; verify the failure
   is actionable and the row refreshes to provider truth.

#### `WL-03` — native promotion (`P3`, opportunistic only)

1. Do not manufacture a cancellation or keep a risky near-term waitlist to force this state.
2. If a safely authorised JAB test waitlist is naturally promoted during the observation window,
   capture the provider notification, booking creation, app refresh, and removal from Waitlists.
3. Verify the app does not run a competing promotion or create a duplicate booking.
4. If the condition does not naturally occur, mark `DEFERRED`, not failed.

### Phase 8 — Auto-Book

#### `AB-01` — create a future Auto-Book (`P0`; approved live queue write)

1. Paid Psycle live execution is `DEFERRED`; use mocks or a verified zero-credit/free Community
   class more than 12 hours away. Select a safe class whose booking window is closed and whose
   `releaseAt` is far enough away that
   it cannot fire during an unsupervised test session.
2. Record gym/event/start/release/studio/eligibility and confirm it is not booked/waitlisted.
3. Open Configure Auto-Book; select preferred spots/rows, quantity within gym limits, fallback-any,
   and Auto-Upgrade option as applicable.
4. Save once and record the queue ID in the cleanup ledger.
5. Verify the row says Scheduled, the Auto-Book card has the correct gym/class/release countdown,
   and the banner selects the earliest queued release.
6. Refresh and log out/in to prove persistence.
7. Verify creating a JAB entry does not show Psycle credits or a Monday-noon countdown.

#### `AB-02` — edit Auto-Book and shared map (`P0`; depends on `AB-01`)

1. Open Edit on the run-created queue entry.
2. Change preference order, row preferences, quantity, and fallback-any within supported limits.
3. Save and verify the queue card updates without duplication.
4. Open the studio map in Settings and Quick-Book configuration; verify the shared map changed
   consistently.
5. Try an invalid zero preference with fallback disabled and verify an actionable validation error.
6. Restore the intended test values.

#### `AB-03` — pause/resume and multi-gym queue ordering (`P1`)

1. Create one safe mock queue entry per gym with different release instants.
2. Verify cards remain gym-labelled and sorted correctly and the banner targets the earliest future
   release.
3. Pause Auto-Book globally; verify entries remain visible but no execution/simulation occurs.
4. Reload, verify pause persists, then resume.
5. Verify resuming does not trigger entries whose release is still in the future.
6. Verify each per-class countdown remains tied to its own gym policy.

#### `AB-04` — cancel Auto-Book (`P0`, mandatory cleanup)

1. Assert the queue ID was created by this run and no execution has occurred.
2. Click Cancel/Delete once; verify confirmation and no mutation.
3. Confirm; verify removal from timetable Scheduled state, Auto-Book queue, and persisted state after
   reload.
4. Verify the underlying preferred studio map remains unless the UI explicitly promised otherwise.
5. Mark the ledger item cleaned.

#### `AB-05` — unattended execution (`P3`, separately scheduled live acceptance)

1. Use only a safe class still at least 7 days away when its release occurs, or an explicitly
   verified free/zero-credit Psycle Community class more than 12 hours away, with enough free
   cancellation time after execution.
2. Obtain explicit authorisation to leave this one queue entry armed, assign an owner, observation
   window, and cleanup deadline.
3. Record pre-release queue/card/health state and confirm push settings.
4. Observe without manual refresh through release; capture execution time versus `releaseAt`,
   selected spot, history result, push notification, and provider booking.
5. Confirm no entry from the other gym fired at the wrong instant.
6. Remove any Auto-Upgrade monitor and cancel the newly created booking within the free window.
7. Confirm provider-side cancellation/allowance restoration and close the ledger.

If a safe class and supervised cleanup window do not coexist, mark `DEFERRED`.

### Phase 9 — Auto-Upgrade

#### `AU-01` — set up Auto-Upgrade (`P0`, run-created booking only)

1. Paid Psycle live coverage is `DEFERRED`; use mocks or a verified zero-credit/free Community
   booking more than 12 hours away when Auto-Upgrade is meaningful for that class. Create or reuse
   a safe booking from this run with a mapped studio and a worse-than-preferred
   current spot.
2. Record current spot, available better spots, gym capability, allowance, and booking ID.
3. Open Configure Auto-Upgrade from My Bookings.
4. Verify current spot and shared preferred map are explained accurately.
5. Select target spots/rows, set any available constraints, and save.
6. Record monitor ID; verify its card in Auto-Book, its status in My Bookings, and persistence after
   reload.
7. Verify JAB is not blocked by Psycle credit arithmetic and Psycle warns accurately when a spare
   credit is required.

#### `AU-02` — edit, disable, delete, and paused state (`P0`; depends on `AU-01`)

1. Edit the run-created monitor's target priority and verify the shared map implications are clear.
2. Save and verify one updated monitor, not a duplicate.
3. Disable/delete the monitor and verify both My Bookings and Auto-Book update after refresh.
4. In mocks, trigger `paused_no_credits`; verify whether the monitor can recover or be resumed when
   eligibility returns.
5. If it cannot, report the known open defect with a fresh reproduction and do not leave the row
   silently paused.
6. Recreate only if needed for `AU-03`; otherwise mark it cleaned.

#### `AU-03` — successful upgrade and provider semantics (`P1`, approved live write)

1. Use a run-created safe booking and monitor with an available preferred target spot.
2. Trigger/observe the poller only through an approved staging/live path.
3. For JAB, verify native atomic swap: the booking never disappears, no cancel/rebook pair occurs,
   and the provider booking ID/semantics remain consistent.
4. For Psycle, verify the documented cancel-then-rebook sequence, capture the new booking ID, and
   immediately update the ledger.
5. Verify My Bookings, timetable, notification, history, and provider system agree on the new spot.
6. Remove the monitor and cancel the current run-created booking safely.

### Phase 10 — bookings management and consistency

#### `MB-01` — My Bookings and Waitlists overview (`P1`)

1. Load the tab with no items, protected existing items, and run-created items at different points
   in the run.
2. Verify chronological sorting, grouping of multiple spots, gym rail/chip, class/studio/location,
   instructor, spot/no-spot state, penalty warning, and monitor status.
3. Verify both gyms appear in one view without duplicate cards or ID collisions.
4. Cross-check a sample against timetable state and provider systems.
5. Pull to refresh and verify removed items do not reappear from stale cache.

#### `MB-02` — same goal from timetable and bookings (`P1`, mock or run-created only)

1. For the same test booking, compare Edit/Cancel from the timetable row and My Bookings card.
2. Verify mobile promotes Cancel appropriately while still keeping Edit reachable for mapped
   classes.
3. Start a confirmation in one view, navigate away, and verify it does not accidentally remain
   armed in the other view.
4. Make one mock-only change from each entry point and verify identical persisted results.

Expected: entry point changes presentation, not business rules or gym routing.

### Phase 11 — calendar, notifications, offline, provider failure, and installed PWA

#### `CAL-01` — unified calendar feed (`P1`)

1. Record the baseline calendar state, then enable it if authorised.
2. Verify exactly one account-level feed URL is shown, not one per gym.
3. Refresh the feed and inspect a sanitised copy: entries from both gyms should coexist, with
   correct `Psycle:`/`JAB:` summary, times, locations, stable UIDs, and no duplicate/cancelled stale
   events.
4. Create and cancel one safe run booking where already authorised; verify the feed updates after
   the app's debounce rather than waiting hours.
5. Rotate the feed URL only on a disposable account and only with approval; verify the old URL stops
   serving and the new one works.
6. Restore disabled/enabled state to baseline.

#### `NOTIF-01` — push permission and preferences (`P1`)

1. Test permission states: default, granted, denied, and unsupported where feasible.
2. Verify Enable Push communicates the browser/device result and does not repeatedly prompt after a
   denial.
3. Open Customise Notifications and inspect all available notification types, including booked,
   waitlist/promotion, upgrade, credit warnings, cancellation/window reminders, and any per-gym
   booking-window sub-toggle.
4. Verify Psycle's weekly booking-window reminder defaults on and JAB's defaults off unless the
   member explicitly overrides them.
5. With debug/test controls only, send each supported test notification and inspect title, body,
   gym name, icons, click target, duplication, and gym-neutral wording.
6. Verify preferences persist and restore the baseline/subscription state.

#### `RES-01` — offline cache and recovery (`P1`, local/staging only)

1. Load all five tabs online and record the last refreshed time/data.
2. Take the browser offline without stopping the app process.
3. Reload or revisit the installed PWA; verify the shell loads and cached timetable/bookings are
   clearly identified as cached/stale rather than current.
4. Try a read refresh and a mutation; verify reads fail gracefully and writes are not falsely
   reported successful or silently queued unless explicitly designed.
5. Return online and verify recovery without logout, duplicates, or cross-gym cache replacement.

#### `RES-02` — one-provider failure (`P0`, controlled staging/mock only)

1. Block or fault one provider adapter through an approved test mechanism; do not attack the live
   provider or induce rate limits.
2. Refresh merged timetable, bookings, waitlists, credits/membership, and settings.
3. Verify the healthy gym continues to render and the failed gym shows a scoped, actionable error.
4. Restore the provider and refresh.
5. Verify recovered data merges without duplicates or stale wrong-gym rows.

#### `PWA-01` — install and mobile device acceptance (`P2`)

1. Install the PWA on a supported test device/profile.
2. Launch from the home-screen icon and verify standalone display, app name/icon, portrait layout,
   safe areas, keyboard avoidance, and bottom navigation.
3. Complete Timetable filter, spot-map modal, Bookings card, Auto-Book card, Settings, and a test
   notification click-through at mobile size.
4. Background and resume the app; verify authentication and pending modal/action state are safe.
5. Test an app update/service-worker refresh; verify the UI does not mix old shell code with new
   cached data indefinitely.

### Phase 12 — cleanup and final reconciliation

#### `CLEAN-01` — mandatory live cleanup (`P0`)

Clean in this order so background automation cannot recreate state while it is being removed:

1. Pause Auto-Book if any run-created entry remains close enough to fire.
2. Delete all run-created Auto-Upgrade monitors and verify removal.
3. Delete all run-created Auto-Book queue entries and verify Scheduled states clear.
4. Leave all run-created waitlists and confirm provider-side removal.
5. Cancel all run-created bookings, newest/current booking IDs only, after rechecking free-cancel
   status; confirm provider-side removal and allowance restoration.
6. Restore changed spot maps and per-gym/account settings from `GATE-02`.
7. Restore push subscription, notification preferences, calendar state, theme, and filters.
8. Relink any gym unlinked for the authorised lifecycle test and verify connection health.
9. Refresh every tab, log out/in, and repeat the bookings/waitlists/queues checks.
10. Compare the final fingerprints and settings to the protected baseline.
11. Apply the credential-retention choice from `CONTROL.md`: delete the disposable Sweat Assistant
    account through `CLEAN-02`, or obtain explicit confirmation to keep encrypted staging links.
12. Clear the QA browser profile/password-save prompt after the final run unless it is deliberately
    retained for an authorised scheduled observation.
13. List any intentional differences. If anything live remains, mark the run incomplete and alert
    the user immediately with the exact safe next action.

#### `CLEAN-02` — disposable account deletion (`P3`, optional and separately authorised)

1. Run only after `CLEAN-01` is a complete pass and after exporting any required sanitised report.
2. Confirm the account is the disposable Sweat Assistant account, not a gym/provider account.
3. Exercise the full Delete All My Data confirmation UX.
4. Verify login no longer succeeds and no account data is visible.
5. Do not assume provider accounts or provider-side historical records were deleted.

## 7. Cross-cutting visual and consistency checklist

Apply this checklist during every flow rather than saving it for one final screenshot pass.

- Correct gym name, logo, tint, terminology, website, membership/credit model, and booking policy.
- Consistent class name, time, instructor, studio, spot, occupancy, and status across Timetable,
  My Bookings, Auto-Book, Auto-Upgrade, calendar, push, and provider confirmation.
- One clear primary action; destructive actions visually distinct and confirmed.
- No contradictory toasts, duplicate messages, success after failure, or stale loading skeletons.
- No clipping, overlap, horizontal page scroll, hidden Save/Cancel, backdrop layering, or content
  under the mobile bottom nav.
- Modal title, close control, focus trap/order, Escape/backdrop behaviour, scroll ownership, and
  focus restoration are correct.
- Light/dark parity, contrast, 12px text floor, visible focus, 44px targets, reduced motion, and no
  colour-only status.
- Desktop/mobile action parity; overflow menus do not hide the only route to an essential action.
- Loading, empty, error, offline, ineligible, full, waitlisted, booked, scheduled, and reconnect
  states are explicit and actionable.
- Data from a previous account, gym, date, or cache never flashes or persists into the new state.
- Provider failures, slow responses, and stale availability do not leave optimistic ghost state.
- Copy says Sweat Assistant and is gym-neutral unless a specific gym is intentionally named.

## 8. Issue report format

Add every distinct defect to `ISSUES.md`. Link repeated observations to the first issue rather than
creating duplicates.

```markdown
## QA-<number> — <short outcome-focused title>

- Severity: P0 | P1 | P2 | P3
- Flow: <flow ID and step>
- Environment/build: <URL or local, version stamp, commit>
- Browser/device: <browser/version, OS, viewport, DPR, theme>
- Persona/gym: <non-sensitive persona and gym>
- Frequency: <n/n attempts>
- Confidence: Confirmed | Likely | Needs investigation
- Cleanup impact: None | Cleaned | LIVE STATE REMAINS

### Preconditions
<State required to reproduce; identify test-created records only.>

### Steps to reproduce
1. ...

### Expected
...

### Actual
...

### Evidence
- Screenshot/video: ...
- Console: <sanitised exact error or "none">
- Network: <method, app-relative route, status, duration, sanitised shape>
- Provider confirmation: <confirmed / contradicted / unavailable>

### Scope and consistency checks
- Other gym affected: yes/no/not checked
- Desktop/mobile: ...
- Light/dark: ...
- Fresh/warm cache: ...
- Existing backlog match: <link or none>

### Notes
<Likely seam or correlation, clearly labelled as inference rather than fact.>
```

Severity guide:

- `P0`: wrong account/gym/class, protected-record mutation, duplicate/early booking, data loss,
  payment risk, auth/PII exposure, or cleanup failure.
- `P1`: a primary goal cannot be completed, booking-window logic is wrong, core multi-gym isolation
  fails, or the only action is inaccessible.
- `P2`: degraded but usable flow, misleading copy/state, accessibility failure, major responsive or
  visual defect.
- `P3`: minor visual polish, edge-case copy, or opportunistic/time-dependent observation.

Known bugs should still receive a fresh run issue with reproduction evidence and a link to the
existing backlog item. Do not quietly omit them and do not report them as newly discovered.

## 9. Completion report

`SUMMARY.md` must contain:

1. environment, build, personas, approvals, and exact scope;
2. count of `PASS`, `FAIL`, `BLOCKED`, `DEFERRED`, and `NOT RUN` by priority;
3. P0/P1 findings first, then P2/P3;
4. core matrix: Psycle-only, JAB-only, multi-gym, desktop, mobile, light, dark, warm cache, offline;
5. live write reconciliation: created IDs, provider confirmation, and cleanup result;
6. protected baseline comparison and any intentional differences;
7. flows needing a future scheduled observation;
8. mechanical test/build output, browser console/network findings, and limits of what was tested;
9. a clear release recommendation: `DO NOT RELEASE`, `CONDITIONAL`, or `ACCEPTED FOR TESTED SCOPE`.

Never use `ACCEPTED FOR TESTED SCOPE` while a P0/P1 failure or live cleanup item remains.

## 10. Ready-to-use browser-agent prompt

Copy the prompt below into the browser automation agent. Supply URLs and secrets separately through
approved channels; do not paste them into the prompt or repository.

```text
You are conducting a structured browser-based QA and live-acceptance run for Sweat Assistant.

Read, in this order:
1. AGENTS.md at the repository root
2. Documentation/Backlog/browser-automation-user-flow-validation.md
3. Documentation/TESTING.md
4. Documentation/Backlog/modular-gyms/OUTSTANDING.md
5. Documentation/Backlog/modular-gyms/LIVE_VERIFICATION_PLAYBOOK.md
6. Documentation/DESIGN.md

Your job is to execute the user flows, validate visible and persisted results, identify bugs,
visual/accessibility issues and inconsistencies, and produce sanitised evidence. Do not modify
application code or fix findings.

Start with Lane A local mocks. Record the actual npm test and production-build results before
browser claims. Then execute the mock-safe flows in dependency order. Create:
Documentation/QA/browser-runs/YYYY-MM-DD-<environment>/CONTROL.md
Documentation/QA/browser-runs/YYYY-MM-DD-<environment>/SUMMARY.md
Documentation/QA/browser-runs/YYYY-MM-DD-<environment>/RUN_LOG.md
Documentation/QA/browser-runs/YYYY-MM-DD-<environment>/ISSUES.md
Documentation/QA/browser-runs/YYYY-MM-DD-<environment>/screenshots/

You are the root QA orchestrator. Run every flow through one fresh, flow-specific subagent using
the "One clean subagent per flow" protocol and template in the plan. Use no inherited conversation
history for each flow when the collaboration tool supports that setting. Run flow subagents
sequentially because they share browser and application state. Maintain the sanitised CONTROL.md,
review every structured handoff, and spawn a dedicated cleanup subagent immediately if a child
leaves live state behind. Never put credentials or tokens in a subagent prompt.

Keep RUN_LOG.md current after every flow. Use PASS, FAIL, BLOCKED, DEFERRED, or NOT RUN exactly as
defined. For each flow inspect the UI, console, network, persisted state after refresh, and the
other gym for cross-contamination. Capture desktop/mobile and light/dark evidence where specified.
Use semantic browser selectors and accessible roles/names instead of coordinates when possible.

Before any Lane B live interaction, stop and present the exact live read/write flow IDs you propose
to run. Obtain explicit session-specific authorisation as required by the live verification
playbook. Obtain credentials only through approved secret input and never echo or store them.

Before every live mutation:
- prove the class meets the time gate: at least 7 full days by default, or more than 12 hours only
  for an explicitly verified free/zero-credit Psycle Community class;
- prove it is outside the cancellation-penalty window;
- prove the target booking/waitlist/queue/monitor is not pre-existing;
- record gym, class start, provider ID, and current state in the run ledger;
- obtain approval for that numbered flow if not already explicitly approved.

Never edit or cancel a pre-existing booking. Never join a waitlist inside the permitted time gate:
7 days by default, or 12 hours only for a verified free/zero-credit Psycle Community class. Never
perform a penalty cancellation, purchase, checkout, payment, or unapproved profile change. Never
let a future Auto-Book remain armed without a named owner and cleanup deadline. Stop immediately
on a wrong-gym mutation, ambiguous destructive target, unexpected penalty, payment screen, 429,
CAPTCHA/WAF response, data exposure, or cleanup failure.

The current Psycle account has no paid credits. Defer paid Psycle booking, Auto-Book execution and
Auto-Upgrade mutations and do not enter checkout. A Psycle live write may use a Community class
only when the UI or provider explicitly confirms it is zero-credit/free and it passes the >12-hour,
free-cancellation, protected-baseline, and approval gates. Continue read-only Psycle coverage and
use mocks for deferred paid mutations.

For each live write, separately verify: UI accepted it, Sweat Assistant persisted it, and the
gym's own system confirmed it. A toast is not sufficient. Add every created provider/app ID to
created_by_this_run before the next action.

Run CLEAN-01 before declaring the run finished, even if earlier flows fail. Remove monitors,
queues, waitlists, and only then test-created bookings; restore maps/settings/notifications/
calendar/gym links; refresh and log out/in; compare with the protected pre-run baseline. If cleanup
cannot be confirmed, stop all further writes and alert the user with the exact remaining live state.

Report known issues with fresh evidence and link them to the existing backlog; do not suppress or
mislabel them as new. Keep credentials, tokens, PII, payment metadata, and raw authenticated
captures out of the repository. Finish with SUMMARY.md using the required release recommendation
and clearly separate mechanical checks, browser validation, provider confirmation, visual-quality
acceptance, blocked/deferred work, and cleanup status.
```
