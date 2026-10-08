# Epic: Admin and operations

**Status:** Active. This epic holds the confirmed admin data-foundation need and the remaining user-owned production setup step.

## Work

| ID | Outcome | Status / dependency |
|---|---|---|
| **C8-1** | Build an immutable system-event trail, durable booking lifecycle ledger, and background profile harvester. Preserve history across provider-cache refreshes and make the records useful to admin operations. | Confirmed user need; original design and data model are in [the archived C8 spec](../Archive/2026-10-08/C8-admin-panel-and-insights.md). |
| **C4-14** | On production, verify `/admin`, create the primary Sweat Assistant account, link Psycle and JAB, then confirm the account and links appear in admin. | User-owned step on `sweat.wingfield.tech`; production was deployed with a fresh database. See [the archived launch record](../Archive/2026-10-08/C4-live-acceptance-and-launch.md). |

## Operating process

Use the ongoing [C9 gym-onboarding playbook](C9-gym-onboarding.md) when adding another tenant. It is a recurring process, not a one-off delivery task.
