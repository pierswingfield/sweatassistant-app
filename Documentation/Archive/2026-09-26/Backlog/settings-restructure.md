# Settings restructure — account vs. per-gym

**Status**: ✅ Phases 1–4 implemented and mechanically verified 2026-09-12; local mock browser smoke passed. Live `needs_relogin` acceptance remains open.
**Implementation**: complete in the current worktree; see [Phases](#phases) and the live acceptance
gate in [modular-gyms/OUTSTANDING.md](./modular-gyms/OUTSTANDING.md).

Parent: [BACKLOG.md](../BACKLOG.md) → "Settings Redesign & Discrete 'Your Gyms' Architecture".

---

## The ask (stakeholder, 2026-09-02)

> Settings needs a refactor and redesign.
> - Booking & Cutoff Modifiers is per-gym, so we should lose that discrete section. Same for
>   Profile Explorer. Most of Booking Settings will become per-gym too.
> - We should create a discrete Your Gyms settings area which allows user to see, auth, remove,
>   add new gyms. Per gym, the user should be able to change individual settings with a settings
>   button, behind which sits all the settings we're moving from global to per-gym.
> - Per-gym, we should be able to see metadata, credits/memberships, profile explorer button,
>   booking/cutoff modifiers, booking settings (incl auto-upgrade engine, spot maps).

---

## Previous structure (before implementation; captured 2026-09-02)

```
Settings
├─ About        What is this? · Features · Privacy & Data · Welcome Tour
├─ Booking      Preferred Spot Maps · Auto-Upgrade Engine
├─ Experience   Appearance · Web Push Notifications · Calendar
└─ Advanced     Your Gyms · Booking & Cutoff Modifiers · Profile Explorer
                Backup & Migration · Debug Mode · Delete All My Data
```

This was the four-pane structure the implementation replaced. The current UI has Account / Your
Gyms / About; do not use this diagram as current source structure.

---

## Historical scope audit — what required migration

At planning time the DB already had the account/gym split, but the rows below exposed the two
misalignments the implementation had to correct. This table is historical evidence, not current
state; the current outcome is recorded in the phase notes.

| Settings card | Belongs to | DB scope then | |
|---|---|---|---|
| Appearance (theme) | account | account | ✅ |
| Web Push + notification prefs | account | account | ✅ |
| Debug Mode | account | account | ✅ |
| Backup & Migration | account | n/a | ✅ |
| Delete All My Data | account | n/a | ✅ |
| Preferred Spot Maps | **gym** | gym (`studio_preferences.gym_id`) | ✅ |
| Calendar | **gym** | gym (token on `user_gyms`) | ✅ |
| Booking & Cutoff Modifiers → window + override | **gym** | gym (`detectedBookingOffset`) | ✅ |
| **Auto-Upgrade Engine** | **gym** (per the ask) | **account** | ❌ **migration** |
| **Timetable Prefetch Range** | account | account | ⚠️ **wrong card** |

### ✅ Auto-Upgrade Engine migration completed

Three Auto-Upgrade keys were account-scoped while the fourth was already gym-scoped. The completed
idempotent migration copied the account values to each linked gym, preserved gym overrides, removed
the old account copies and made all four settings consistently gym-scoped.

### ✅ Prefetch Range placement corrected

"Timetable Prefetch Range" remains account-scoped and now lives under Account → App Behaviour; it
did not move into the per-gym drawer with booking-window controls.

---

## Proposed structure

```
Settings
├─ Account       Password · Appearance · Notifications · App Behaviour
│                Backup & Migration · Delete All My Data
│
├─ Your Gyms     ┌─────────────────────────────────────────────────────┐
│                │  ● Psycle London        14 cr        [⚙] [⋯]        │
│                │  ● JAB Boxing Club      Member       [⚙] [⋯]        │
│                │  ⚠ Old Gym              Re-auth      [⚙] [⋯]        │
│                │                                                     │
│                │  ＋ Connect another gym                             │
│                └─────────────────────────────────────────────────────┘
│
└─ About         What is this? · Features · Privacy & Data · Welcome Tour
```

Three sections instead of four. **Booking** and **Experience** dissolve — their contents split by
scope into Account or into the per-gym drawer. `⋯` is re-authenticate / unlink; `⚙` opens the
drawer.

### Per-gym drawer

```
┌─ Psycle London ─────────────────────────────────────── [Close] ─┐
│                                                                 │
│  CONNECTION                                                     │
│  piers@example.com                                   ● Active   │
│  [Re-authenticate]  [Unlink gym]                                │
│  ─────────────────────────────────────────────────────────────  │
│  MEMBERSHIP & CREDITS                                           │
│  14 credits available                          [Buy credits →]  │
│  ─────────────────────────────────────────────────────────────  │
│  BOOKING WINDOW                                                 │
│  15 days  (auto-detected from your membership cutoffs)          │
│  Manual override (debug)                   [ Auto (detected) ▾] │
│  ─────────────────────────────────────────────────────────────  │
│  AUTO-UPGRADE ENGINE                                            │
│  Enabled                                              [  ●   ]  │
│  On by default for new bookings                       [   ●  ]  │
│  Check interval                                 [ Every 15m ▾]  │
│  Continue past 12h cutoff by default                  [   ●  ]  │
│  ─────────────────────────────────────────────────────────────  │
│  SPOT MAPS                                                      │
│  4 studios mapped                              [Manage maps →]  │
│  ─────────────────────────────────────────────────────────────  │
│  ADVANCED                                                       │
│  Calendar feed  ● Enabled              [Copy link]  [Rotate]    │
│                                          [Profile Explorer →]   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Capability-gated per gym, so a membership gym renders differently — the same rules as everywhere
else above `providers/`, and **an unknown flag still defaults to ON**:

```
┌─ JAB Boxing Club ───────────────────────────────────── [Close] ─┐
│  MEMBERSHIP & CREDITS                                           │
│  ● Rolling monthly membership · 2 guest passes left             │
│    Managed on JAB's own site.                     [Open site ↗] │
│  ─────────────────────────────────────────────────────────────  │
│  BOOKING WINDOW                                                 │
│  Published per class by the gym — nothing to configure.         │
└─────────────────────────────────────────────────────────────────┘
```

### The n=1 rule — carry D8 forward

Decision D8 (merged multi-gym views) says a single-gym account must not pay for multi-gym
plumbing. **Same rule here**: with one linked gym, don't make the user click into a drawer to
reach settings they've always had at the top level.

```
Settings  ·  single-gym account
├─ Account
├─ Psycle London     ← the gym's own section, rendered inline. No card, no drawer.
│                      [Re-authenticate] [Unlink] live at the bottom of it.
└─ About
```

Same components either way — the gym section is one renderer, called inline for n=1 and inside a
drawer for n≥2. Assert it with a test rather than assuming, exactly as D8 asks.

---

## Phases

Ordered so each phase ships something and nothing is half-migrated at a phase boundary.

| | Phase | What | Size |
|---|---|---|---|
| 1 | **Scope migration** | ✅ Moved `autoUpgrade*` to gym scope, backfilled linked gyms and kept `prefetchWeeks` account-scoped. | Complete |
| 2 | **Extract the gym section renderer** | ✅ One function rendering connection + membership + window + auto-upgrade + spot maps + calendar + profile explorer for a given `gymId`. Rendered inline in the existing four-pane UI. | Complete |
| 3 | **Restructure the subnav** | ✅ Collapsed to Account / Your Gyms / About. Gym cards + `⚙` drawer for n≥2, inline for n=1. Deleted the old Booking and Experience panes. | Complete |
| 4 | **Polish** | ✅ Per-gym accenting inside the drawer, empty states, full-screen mobile treatment and an actionable `needs_relogin` warning. | Complete |

Phase 1 implementation note (2026-09-12): `autoUpgradeEnabled`, `autoUpgradeByDefault` and
`autoUpgradeInterval` are now gym-scoped alongside `autoUpgradeKeepOriginalByDefault`.
An idempotent database migration backfills old account values to every linked gym, preserves an
existing gym override and removes the account copies. `prefetchWeeks` remains account-scoped.
`server/test-gym-isolation.js` pins the scope and migration behaviour.

Phase 2 implementation note (2026-09-12): `ui/gym-settings-section.js` owns one DOM renderer for
connection, membership/credits, booking window, Auto-Upgrade, spot maps, calendar and Profile
Explorer. `settings.js` supplies explicit `gymId`-scoped data/actions and mounts the active gym in
the existing Booking pane. The previously scattered calendar, booking-window and profile cards
were removed; account-scoped `prefetchWeeks` now appears under Experience → App Behaviour. The
API methods used by the renderer accept an explicit gym id, including settings, profile, credits,
calendar and spot-map reads/writes. The component tests cover the credit and membership variants,
the per-class window, capability behaviour and action/setting bindings. The initial in-app browser
attempt was blocked, but the later Phase 3 smoke connected successfully and covered this renderer.

Phase 3 implementation note (2026-09-12): Settings now has three scope-based panes: Account,
Your Gyms and About. A single-gym account sees its gym name in the subnav and the shared gym
renderer inline. With multiple gyms, the pane becomes a gym list and each settings button opens the
same renderer in a desktop drawer/full-screen mobile surface. The n=1/n>=2 presentation rule has a
unit test. Browser smoke passed in the local mock UI for both shapes: the Psycle-only inline view,
then Psycle plus mock JAB with JAB membership, per-class window and gym-specific controls in the
drawer. During that smoke, onboarding was also fixed to use `getCalendarStatus()` after its removed
`isCalendarEnabled()` call froze the flow.

Phase 4 implementation note (2026-09-12): the drawer reads the gym's configured primary colour
into a local accent token without changing the rest of the app theme; mobile uses the same renderer
in a full-width surface. A `needs_relogin` link now gets a clear warning explaining that background
bookings and calendar updates need re-authentication, while preserving the gym and its settings.
The warning/accent path is unit-tested. The JAB accent and responsive drawer were visually checked
in the local two-gym mock browser; inducing a real expired-provider session remains a live acceptance
case rather than a mechanical test.

Phase 1 was the only data-sensitive phase and is pinned by the gym-isolation migration tests.

---

## Resolved implementation decisions

1. ✅ **Resolved 2026-09-12:** Auto-Upgrade is per gym because provider capabilities, bookings,
   polling cost and upgrade behaviour differ by gym. Existing values are used as the backfill.
2. ✅ **Delete All My Data remains account-level.** Unlinking a gym removes that link and its
   gym-scoped queues, maps, settings, caches and calendar data; it does not delete the SA account.
3. ✅ **The SA account password lives under Account**, independent of any gym credential.
4. ✅ **Desktop uses a drawer; mobile uses the same renderer in a full-width surface.**

---

## Related

- [modular-gyms/OUTSTANDING.md](./modular-gyms/OUTSTANDING.md) — current build order and live acceptance
- [multi-gym-buy-credits.md](./multi-gym-buy-credits.md) — the "Buy credits →" and membership
  surfaces referenced from the drawer above
