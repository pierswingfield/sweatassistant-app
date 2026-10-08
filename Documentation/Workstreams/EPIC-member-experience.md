# Epic: Reported bugs and feedback

**Status:** Active. This is the current, actionable register for the bugs and UI changes reported by the user in this thread. All U6 items below are open until implemented and verified.
**Source record:** the detailed original feedback is preserved in [`U6 user-reported polish`](../Archive/2026-10-08/U6-user-reported-polish.md). Track and update status here; the archived file is historical context only.

## Work

| ID | Outcome |
|---|---|
| **U6-1** | **Bug:** Fix calendar-feed handoff from the PWA so returning from Mobile Safari does not leave a blank webview. |
| **U6-2** | **Bug:** Recolour the safe-area header when system light/dark mode changes while the app is open. |
| **U6-3** | Make the timetable action text-only: “Quick Book”, with no lightning icon. |
| **U6-4** | Slightly increase timetable time text size on mobile. |
| **U6-5** | Tapping a booking's spot opens actions for Change spot, Auto-Upgrade when available, or Cancel; each opens the correct full-screen flow. |
| **U6-6** | Show the Auto-Upgrade tip once, only if not enabled in every linked gym where available. Copy: “[emoji] Tip: Enable Auto-Upgrade in gym settings so I can automatically grab you a better spot when one becomes available!” |
| **U6-7** | Move the offline banner above the app header so it does not obscure page content. |
| **U6-8** | **Bug:** Fix instructor autocomplete filtering across gyms and restore the exact pre-search filter state on exit or clear. |
| **U6-9** | Vertically align the collapsed “N Locations” label in the mobile filter bar. |
| **U6-10** | Remove the dark line at the top of collapsed `fr-gymquick`; verify the iOS rendering. |
| **U6-11** | Disable the My Bookings refresh animation on mobile, where pull-to-refresh is already available. |
| **U6-12** | **Regression:** Display JAB Recovery classes as “Recovery”, without “(MEMBERS)”. |
| **U6-13** | Adjust mobile timetable layout for timezone-extended times: move gym logo and class type chip right to make room, and nudge time right for optical alignment. |
| **U6-14** | Re-order collapsed mobile filter gym logos: place active (unfiltered) gym logos leftmost and on top of blurred logos in z-index, with blurred logos behind and to the right. |
| **U4-19** | Wire the existing `q` URL parameter to the timetable search UI. Preserve the documented history and clear/restore behavior. |

## Acceptance notes

- Follow [`AGENT_PROTOCOL.md`](AGENT_PROTOCOL.md) before implementation: confirm the issue in code and a real browser, then verify the fix.
- U6-1 and U6-10 need an installed iOS PWA check. U6-8 needs multi-gym autocomplete coverage and exact pre-search state restoration.
- U4-19 PWA checks are user-confirmed complete; the `q` parameter is still not connected to the search UI.
