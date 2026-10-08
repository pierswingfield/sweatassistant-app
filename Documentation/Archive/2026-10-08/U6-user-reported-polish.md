# U6 — User-reported post-launch polish

> **Archived 2026-10-08.** U6-1..12 are tracked in the active [Member experience and reliability epic](../../Workstreams/EPIC-member-experience.md).

**Status (2026-10-08):** New backlog from the user's reported issues. All items below are open and unverified; this document records scope and acceptance outcomes, not implementation evidence.
**Priority:** Triage as a post-launch UX/regression batch. Fix regressions (search, class naming, theme, calendar handoff) ahead of copy and visual polish.

## Items

| ID | Area | Outstanding work / acceptance outcome |
|---|---|---|
| **U6-1** | Calendar feed handoff | Opening the calendar feed from the PWA currently routes through the PWA and Mobile Safari; returning to the PWA leaves a blank white webview. Make feed opening/return behavior safe and predictable, with no blank PWA view. |
| **U6-2** | Theme / safe area | When system light/dark mode changes while the app is open, recolour the safe-area header with the rest of the app. |
| **U6-3** | Timetable Quick Book | Change the Quick-Book action to text-only **“Quick Book”**, with no lightning icon. |
| **U6-4** | Timetable mobile type | Increase the timetable class-time text size slightly on mobile. |
| **U6-5** | My Bookings spot actions | Tapping a booking's spot number should open a compact action chooser: Change spot, enable/disable Auto-Upgrade when available, or Cancel. Each action must open its appropriate full-screen flow. |
| **U6-6** | Auto-Upgrade tip | Show the tip once only, and only when Auto-Upgrade is not enabled for every linked gym where the setting is available. Replace the copy with: **“[emoji] Tip: Enable Auto-Upgrade in gym settings so I can automatically grab you a better spot when one becomes available!”** |
| **U6-7** | Offline banner | Place the offline banner above the app/Psycle header as well as page content so it does not obscure content. |
| **U6-8** | Timetable search regression | Selecting an instructor autocomplete result (reported for Johan / Psycle) must show only the relevant classes, applying the required gym-specific instructor filter without leaking other gyms' results. Search must snapshot the pre-search filter state; exiting search or clearing it restores that exact state. |
| **U6-9** | Mobile filter bar alignment | Vertically align the collapsed “N Locations” label within its container. |
| **U6-10** | Mobile filter bar rendering | Remove the dark line at the top of `fr-gymquick` when gym icons collapse into overlapping circles; reproduce on iOS, where it is visible. |
| **U6-11** | My Bookings refresh | Disable `app-bookings-refreshing` on mobile; pull-to-refresh already provides the refresh affordance. |
| **U6-12** | JAB class naming regression | Show JAB Recovery classes as **“Recovery”**, not **“Recovery (MEMBERS)”**. |

## Verification

- Follow [AGENT_PROTOCOL.md](../../Workstreams/AGENT_PROTOCOL.md) before implementing items: verify the basis in code and in the real browser first, then re-verify the result.
- Mobile-only behavior, including the `fr-gymquick` rendering and PWA calendar handoff, needs an iOS/device check before being marked fully verified.
- Search acceptance must cover multi-gym filters, autocomplete selection, and restoring the exact pre-search state after both exit and clear.
