# Multi-gym Buy Credits → "Credits & Membership"

**Status**: 🟡 Phases 1–3 implemented 2026-09-12; mechanically verified, dedicated Credits-tab
browser acceptance still open. The selector remains deferred until a second gym can sell credits.

Parent: [BACKLOG.md](../BACKLOG.md) → "Multi-Gym Buy Credits → Credits & Membership".

---

## The ask

Stakeholder, 2026-09-02: *"Buy Credits is not implemented for multi-gym."*

BACKLOG/P1 states it as: *"Buy Credits Tab: permanently visible when multiple gyms are linked, with
a submenu/dropdown to select which gym to buy credits for (only displaying gyms where
`creditPurchase: true`, e.g. Psycle London enabled, JAB Boxing hidden)."*

---

## What was broken at planning time vs. what was speculative

Historical planning snapshot from 2026-09-02. Phases 1–3 below are now implemented; this table
explains why the selector remains deliberately deferred.

| Sub-ask | State |
|---|---|
| Tab visible when multiple gyms are linked | ✅ **Already done.** `gateByCapability()` (`gym-context.js:145`) special-cases `[data-tab="buy-credits"]` to use `canAny()` instead of `can()`, so the tab shows whenever *any* linked gym is purchasable — regardless of which gym is active. |
| Only offer gyms where `creditPurchase: true` | ✅ **Already done.** `initBundles()` (`credits.js:64`) picks `linked.find(g => g.capabilities?.creditPurchase === true)` first. |
| A **dropdown** to pick which gym to buy for | ⚠️ **Speculative.** `creditPurchase: true` is set on exactly one gym (`psycle-london`); JAB is `false`. A selector would render with **one option** and change nothing a user can see. It only earns its place when a second purchasable gym exists. |
| Membership gyms handled | ✅ **Implemented 2026-09-12.** JAB membership status, dates and guest-pass counts render in the shared membership surface. |

The implemented solution reframes the tab from "Buy Credits" (a Psycle concept) to **"Credits &
Membership"**, sectioned per gym. The sections are the selection surface and preserve the n=1 view.

Two further findings from that planning pass:

- ✅ **The 3-D Secure website fallback was hardcoded to Psycle.** It now uses the target gym's
  config-driven `websiteUrl`.
- **`/bundles` is one of the 3 remaining `/api/proxy` callers.** Its deletion is the acceptance
  criterion for the old layer D (see [modular-gyms/OUTSTANDING.md](./modular-gyms/OUTSTANDING.md)).
  Anything built here either normalizes it or entrenches it.

The former `renderNoPurchaseState()` dead-end was replaced by the JAB membership section; a JAB-only
account now sees Credits & Membership instead of having the tab hidden.

---

## Proposed shape

```
┌─ Credits & Membership ──────────────────────────────────────────┐
│                                                                 │
│  PSYCLE LONDON                                     14 credits   │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │  5 classes │ │ 10 classes │ │  Unlimited │   … bundle cards  │
│  │    £75     │ │    £140    │ │   £180/mo  │      (as today)   │
│  └────────────┘ └────────────┘ └────────────┘                   │
│  [ Search bundles… ]  [ filters, as today ]                     │
│                                                                 │
│  ═══════════════════════════════════════════════════════════    │
│                                                                 │
│  JAB BOXING CLUB                                  ● Membership  │
│  Rolling monthly · renews 1 Oct · 2 guest passes remaining      │
│  Memberships are managed on JAB's own site.       [Open site ↗] │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Single-gym accounts see exactly one section and no divider** — identical to today for a
Psycle-only user (the D8 n=1 rule again). A JAB-only user gets the tab *back*, showing their
membership instead of an empty state — which is strictly better than today, where the tab is
hidden and their membership is nowhere in the app.

When a second purchasable gym eventually exists, the section header is the natural place to grow a
jump-link row, and no dropdown is needed at all:

```
│  Jump to:  [ Psycle London ]  [ Second Gym ]        ← only when 2+ purchasable
```

---

## Server work

| | What | Why |
|---|---|---|
| 1 | **`GET /api/membership` → `NormalizedMembership \| null`** | Wire the existing, unrouted `marianatek.getMemberships()`. Suggested shape: `{ name, status, isActive, renewsAt?, guestPassesRemaining?, manageUrl? }`. CodexFit returns `null` — it has no membership object, it has credits. Mirrors how `/api/credits` already branches on `typeof provider.getCredits === 'function'`. |
| 2 | **`shortName` is done; add `websiteUrl`** to `gyms.config.js` | Kills the hardcoded `psyclelondon.com` fallback, and gives the JAB section its "Open site ↗" target. Thread it through `/api/gyms` the same way `shortName` was on 2026-09-02. |
| 3 | *(optional, unblocks layer D)* **Normalize `/bundles`** | `GET /api/purchasables` returning a normalized bundle shape would remove one of the last 3 `/api/proxy` callers. Defer-able: the current call already passes an explicit `gymId`, so it is not *wrong*, just deprecated. |

Note the cart flow architecture: `cartInstanceId` (migrating to `cartUuid` under CodexFit v2) is already per-gym (`settings` table, not
`account_settings`), and `POST /api/cart/checkout/init|confirm` already resolve through the active
gym. Upstream CodexFit v2 uses UUID path parameters (`/cart/{uuid}/...`) rather than query-parameter `instance`.

---

## Phases

| | Phase | What | Size |
|---|---|---|---|
| 1 | **Membership route** | `GET /api/membership` + `NormalizedMembership` typedef + adapter impls (MT real, CodexFit `null`). Test: a membership gym reports its membership; a credit gym reports `null` — no credit arithmetic involved. | ~half day |
| 2 | **Per-gym sections** | Rename the tab to "Credits & Membership". `initBundles()` loops linked gyms instead of picking one: `creditPurchase` gyms render bundle cards, others render a membership card. Drop `renderNoPurchaseState()` into the membership branch. | ~half day |
| 3 | **`websiteUrl` config** | Add the field, thread through `/api/gyms`, use it for the 3DS fallback and "Open site ↗". | ~1 hr |
| 4 | **Deferred** | Jump-links / selector — **only when a second `creditPurchase: true` gym exists.** Don't build it before then; it has one option. | — |

Implementation note (2026-09-12): phases 1–3 are present in the current worktree. The normalized
route is `/api/membership`; the client renders a membership section for non-purchasable linked
gyms and retains the existing bundles for purchasable gyms. Checkout init/confirm now carry the
target `gymId`, and website fallbacks come from `gyms.config.js`. Verification: 16/16 server
suites, 60/60 client tests, production client build. The Credits tab still needs its dedicated
live browser acceptance; the later Settings smoke did reach localhost and verified the shared
membership presentation, so the old `ERR_BLOCKED_BY_CLIENT` note is no longer a general browser
blocker.

---

## Open questions

1. ✅ **Resolved 2026-09-12:** the tab appears for a JAB-only user as "Credits & Membership" and
   shows membership state rather than an empty purchase surface.
2. **Is `manageUrl` per-gym config or from the provider payload?** MT's membership payload may
   carry a portal link; if not, it's `websiteUrl` from `gyms.config.js`.
3. 🟡 `/api/membership` remains a richer sibling to `/api/eligibility`. They are fetched at
   different interaction points today; if they become co-loaded, consolidate the provider read or
   add a bounded shared result rather than issuing duplicate upstream calls.

---

## Related

- [settings-restructure.md](./settings-restructure.md) — the per-gym drawer links here from its
  "Membership & Credits" row
- [3d_secure_checkout.md](./3d_secure_checkout.md) — the in-app 3DS flow this shares a fallback with
- [modular-gyms/OUTSTANDING.md](./modular-gyms/OUTSTANDING.md) — layer D (`/api/proxy` deletion)
