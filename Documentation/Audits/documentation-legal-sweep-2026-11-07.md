# Documentation and legal draft sweep — 7 November 2026

## Scope and result

Inventoried all 102 tracked/worktree Markdown files present at the start. Gemini Flash reviewed the 38 non-archive/reference files in four batches, after an instruction/manifest pass; direct targeted reads verified the claimed corrections. A separate Flash source locator and one grounded legal-source lookup made seven successful Gemini calls total (six Flash, one grounded). Official ICO/CMA/legislation sources were independently checked; [legal review notes](../Legal/REVIEW-NOTES.md) list sources and failed lookups.

Fourteen existing documents changed; five new documents were added, including this audit. Active operational domains, branch/deployment status, landing status and testing guidance were corrected. [Current operations](../Operations/CURRENT.md) is the entry point for deployed topology, calendar UID preservation and origin-specific sign-in/install/push. Original domain migration recommendations remain clearly marked as the pre-implementation plan; the deployed topology and receipt take precedence.

The 64 frozen archives and dated browser receipts are historical evidence and were left intact. Dated audits/operations records that could be mistaken for current runbooks now have an explicit historical banner. Their original hostnames and rollback instructions remain unchanged. The remaining legacy domains in plans, audits and progress entries are historical context, original migration baselines or intentional calendar namespaces/compatibility endpoints; they are not live navigation instructions.

## Links and missing evidence

Sixteen broken relative Markdown file links were found in the original active/reference corpus. Ten were corrected to existing moved files or the current playbook; six missing Home browser receipts were converted to explicit “absent from this checkout” statements. Their missing evidence is not re-created or represented as verified:

- `home-instructor-card-layout-2026-10-20.md`
- `home-focus-firstload-2026-10-20.md`
- `home-booked-day-spa-2026-10-21.md`
- `home-compact-controls-2026-10-22.md`
- `home-tab-scroll-state-2026-10-22.md`
- `home-section-card-polish-2026-10-22.md`

The local checker resolves Markdown relative file targets after URL decoding and ignores anchors. External URLs, prose/code references, historical archive links, and external services were not exhaustively crawled. No formal documentation check exists in root package scripts. `git diff --check` and the local link checker are the relevant verification for these Markdown-only edits; application tests/build/browser checks were not rerun or claimed by this phase.

## Legal drafts and next UI phase

[Terms draft](../Legal/TERMS-DRAFT.md) and [Privacy draft](../Legal/PRIVACY-DRAFT.md) are unpublished drafts. Missing operator identity/contact, provider/transfer arrangements, final retention and legal review are explicit prerequisites. No legal acceptance flow, new processing, infrastructure or publication was added.

Existing app copy (`client/src/copy.js`, `privacyDescription` and `aboutSecurity`) says “Your data is encrypted” and implies immediate deletion of all data. Its claim should be narrowed to gym password/session encryption, disclose server decryption for background features, and distinguish live deletion from backups/external copies. The landing “delete ... everything” sentence also needs that qualification when legal pages are published. These are identified for the sequential UI agent; this documentation phase did not edit app/landing code.

UI locator handoff: `client/src/ui/onboarding.js` (`stepFeatures`, checkbox label); `client/src/ui/bookings.js` opens `client/src/ui/share-sheet.js` (period selector). These locations were verified by targeted source search; no UI diagnosis or fix is claimed here.

## Active/reference files reviewed

- `CLAUDE.md`
- `AGENTS.md`
- `Documentation/Services/soulcycle.md`
- `Documentation/Services/provider-stats-audit.md`
- `Documentation/Services/psycle_codexfit.md`
- `Documentation/Services/marianatek.md`
- `Documentation/QA/modal-to-fullscreen-spec.md`
- `Documentation/QA/spotmap-booking-flow-spec.md`
- `Documentation/Workstreams/EPIC-member-experience.md`
- `Documentation/Workstreams/BACKLOG.md`
- `Documentation/Workstreams/TEAMS-UX-REVISION-2026-11-07.md`
- `Documentation/Workstreams/PLAN-domain-dibs-fit.md`
- `Documentation/Workstreams/PLAN-mcp-server.md`
- `Documentation/Workstreams/mcp-security-research.md`
- `Documentation/Audits/cssv2-baseline.md`
- `Documentation/Audits/psycle-naming-audit.md`
- `Documentation/Audits/cssv2-spinner-audit.md`
- `Documentation/Audits/backup-notifications-handoff.md`
- `Documentation/Audits/default-gym-and-infra-plan.md`
- `Documentation/Audits/css-debt-audit.md`
- `Documentation/Workstreams/M-landing-page.md`
- `Documentation/Workstreams/PLAN-app-restyling.md`
- `Documentation/Workstreams/PROGRESS-teams.md`
- `Documentation/Workstreams/H-home-design-spec.md`
- `Documentation/DESIGN.md`
- `Documentation/Operations/node2shell-remediation.md`
- `Documentation/TESTING.md`
- `Documentation/Workstreams/C9-gym-onboarding.md`
- `Documentation/Workstreams/PLAN-teams.md`
- `Documentation/Workstreams/M-name-check.md`
- `Documentation/Workstreams/EPIC-admin-operations.md`
- `Documentation/Workstreams/README.md`
- `Documentation/Workstreams/AGENT_PROTOCOL.md`
- `server/fixtures/codexfit-v2/PARITY.md`
- `Documentation/QA/AUTOBOOK-HANDOFF.md`
- `Documentation/QA/modal-audit.md`
- `Documentation/QA/USER_FLOW_VALIDATION_PLAN.md`
- `Documentation/LIVE_VERIFICATION_PLAYBOOK.md`

## Verification output

```text
DOC LINK CHECK: 43 active/reference/draft Markdown files; 188 relative file targets; 0 missing
GIT DIFF CHECK: PASS (no whitespace errors)
Terms draft: 783 words
Privacy draft: 900 words
```

The root package scripts were inspected: no formal Markdown lint/link command is defined. These checks validate local document paths and whitespace, not legal completeness, external URL availability, browser behavior or remote deployment state.
