# Provider stats audit (H-8)

**Status:** audited 2026-10-07. This is the prerequisite for H-9, the Home stats widget; it is not that widget's implementation.

## Evidence and safety boundary

The 2026-10-07 live pass used the signed-in dev twin, sequential read-only app requests, and no mutation route. It made at most 14 provider reads even if the history cache had required its five-page refresh, below the 40-request playbook cap. No rate-limit header, `429`, WAF response, or authentication ambiguity occurred after the initial app-session check.

Current live evidence is deliberately limited to response status and non-personal field names. The full-history depth and row semantics below remain the separately documented 2026-10-05 sanitized live study in [H-home-page.md](../Workstreams/H-home-page.md#open-questions), rather than a claim that the current pass repeated that pagination.

| Platform | Current 2026-10-07 read | What it proves |
|---|---|---|
| CodexFit (Psycle) | `GET /api/profile` and `GET /api/attendance-totals` both returned JSON 200. | The profile still carries provider `stats` fields and the supported official-attendance route remains available. |
| MarianaTek (JAB) | `GET /api/profile` returned JSON 200 with no normalized stats object; `GET /api/attendance-totals` returned the expected capability-gated 501; `GET /api/history` returned the durable history contract. | There is no JAB official-total capability in the app; history is the supported source for derived activity metrics. |

The required JAB booking, waitlist and credit inventories were read before and after the audit. The post-audit reads all returned JSON 200; no action endpoint was called. The pre-audit request collector expired after completing its sequential reads, so its aggregate counts are intentionally not recorded as comparison evidence.

## Classification

“Provided” means the provider exposes the value. It does **not** mean the current normalized app surface promotes it. “Derivable” means derive it from `class_history` using the established status and distinct-class rules. “Unavailable” means do not infer it from a nearby field.

| Platform | Candidate stat | Classification | Source and limits |
|---|---|---|---|
| CodexFit | Official attended-class total; current-week/month/year overview | **Provided** | `/milestones`, surfaced through `GET /api/attendance-totals` for the supported gym. The 2026-10-05 sanitized live study establishes that `attended_events` excludes no-shows. |
| CodexFit | Total attended minutes | **Provided** | Profile `stats.total_attended_minutes`. It is not safely reconstructible from past booking rows. |
| CodexFit | Total bookings, unique bookings, unique attended bookings, upcoming bookings | **Provided** | Profile `stats` contains the counters. They remain provider fields inside the profile payload rather than normalized stats API fields. |
| CodexFit | Distinct booked-class count, booked minutes, instructor count | **Derivable** | `class_history`, deduplicated by class/event and labelled **classes booked**, not attended classes. |
| CodexFit | Per-class attendance/no-show status | **Unavailable** | Past rows have no separating attendance signal; never turn an inferred count into “classes taken.” |
| MarianaTek | Official attended-class total or period overview | **Unavailable** | No equivalent current capability: `GET /api/attendance-totals` is 501 for JAB. |
| MarianaTek | Distinct class count, total minutes, instructor count | **Derivable** | Normalized reservation history (`GET /api/history`): count only established attended/unconfirmed statuses and deduplicate classes. |
| MarianaTek | Membership/credit entitlement | **Provided, not an activity stat** | Profile, credits and eligibility reads expose current entitlement; do not use them as a count of classes taken. |
| MarianaTek | `/me/account` activity aggregate | **Unavailable** | The normalized profile has no stats object. Prior sanitized account captures show account and membership state, not an attendance aggregate. |
| MarianaTek | `/me/orders` activity aggregate | **Unavailable** | No supported normalized app route; prior sanitized membership-paid evidence was an empty order set. Do not treat orders as reservations or attendance. |

## H-9 implementation guardrails

1. Prefer the official CodexFit attendance total where the capability is present.
2. Label history-derived values as **classes booked** unless a provider supplies attendance semantics.
3. Show only metrics classified above as provided or derivable; a missing platform capability is an omitted metric, not zero.
4. Keep all aggregates gym-scoped until the final cross-gym sum; provider identifiers are not globally unique.
