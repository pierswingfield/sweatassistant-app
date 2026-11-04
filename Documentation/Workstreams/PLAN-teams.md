# Work plan: Teams (shared upcoming classes for small groups)

**Status:** Proposed, 2026-11-04. Nothing is built. Expands F-3 (social class sharing: "who's going", friend graph). The decisions in §9 were settled by the user on 2026-11-04; mock-ups (T-0) are the next step.

## 1. Outcome

A member can create or join small private groups, called **Teams** (a group chat, friends, a couple, a running club; at most 16 members). Inside a Team they can see who is doing which classes, find classes several members are already in, and book into them. Each member decides per Team exactly what they share, and the server enforces that decision.

Non-goals for this plan: public profiles, following strangers, discovering Teams by search, chat (the group chat already exists elsewhere, and a Team is its companion), and anything that books or cancels on someone else's behalf.

## 2. Privacy principles (these govern every later decision)

1. **The server projects, the client displays.** A viewer's response contains only what each sharer allowed for that Team and what the viewer may see. No client-side filtering of data the viewer has already received. One server function, `projectTeamFor(viewerId, teamId)`, produces every Team payload, and one suite pins it (§8).
2. **Consent per Team, shown in plain words.** Joining always passes through a "What you'll share with *Team name*" screen. You cannot join without seeing it. It can be changed later from the Team and from one account-level overview.
3. **A pending requester sees nothing.** Before approval, the requester sees the Team's name and mascot only: no member count, member names or activity.
4. **The invite link is a revocable secret, not the Team's identity.** The URL carries a random 128-bit token that is separate from the Team id. Rotating it invalidates every old link without disturbing members. Link unfurls in chat apps (Open Graph tags) are generic ("You've been invited to a Team on Dibs"), because the people in a chat are not necessarily the people being invited.
5. **Leaving is immediate and complete.** Leaving, being removed, pausing or deleting the account removes the member from every projection at once. Nothing they shared stays visible as a cached copy on the server.
6. **No identity leakage across the boundary.** Never show email addresses, gym login identities or user ids. A member is identified by a display name and avatar only.
7. **Location plus time is sensitive.** "Sam will be at Psycle Oxford Circus at 08:30 tomorrow" is exactly the information a stalker wants. Hence approval-only membership, an easy per-Team pause, the "Who can see my classes" overview, and conservative defaults for the most precise data (spot numbers).

## 3. Sharing model

A per-member, per-Team record called `share`. **Defaults (D3, agreed): everything on except spot numbers and the auto-book queue:**

| Setting | What the Team sees | Default |
|---|---|---|
| Gyms | "All my gyms" (including gyms linked later) or an explicit list | All my gyms, **on** |
| Upcoming classes | Gym, class, time, studio/location, instructor | **On** |
| Waitlists | "On the waitlist for…" | **On** |
| Activity counts | Classes this week and this month, and the Team mascot's activity | **On** |
| Recent classes | An itemised list of past classes (from H-0, the class-history store) | **On**, limited to the last 30 days |
| Spot numbers | "Bike 14", so friends can pick neighbouring spots | **Off** (most precise; opt in) |
| Auto-book queue | "Trying for 08:30 Train on Mon", useful for coordinating releases | **Off** (it reveals intent before a booking exists) |
| Friendly competition | The member appears in leaderboards and streaks | **Off** (team setting plus a member opt-in) |
| Pause | Hide me from this Team until I unpause, or for 24 h or 7 days | Off |

- A newly linked gym joins "All my gyms" automatically, and the gym-link confirmation says "Shared with 2 Teams. Change." so this is never silent.
- Cancelled bookings disappear from the projection. Late-cancel and no-show statuses are **never** shared, whatever the settings.
- Settings → Privacy gets a **"Who can see my classes"** page that lists every Team, what it can see, and quick Pause/Leave actions. That is the one place to audit everything.

## 4. Viewer rule: other gyms

The brief says other members' classes at a gym the viewer has not linked are not shown. Refinement (D2, agreed): **details are hidden but the activity still counts.** The Team mascot, "8 classes today" and member counts include them, shown as "+2 at other gyms" with no gym, time or class. Without this, a JAB-only member sees a mascot resting while the Psycle members are all mid-class, and the dashboard misdescribes the Team's day. The sharer has already chosen to share that gym with the Team, so the count reveals nothing they withheld.

A gym the viewer has linked but paused (`user_gyms.account_enabled = 0`) is treated as linked for visibility. The Book CTA then says "Turn on *Gym* to book".

## 5. UX

### 5.1 Navigation

Teams gets its own primary destination (D1, decided). The Credits tab is hidden for all users and is not expected back, so the nav becomes **Home · Timetable · Bookings · Auto-Book · Teams · Settings** on both the iOS bottom nav and the desktop nav. Credits stays reachable from Home's credits tile. Credits is currently re-shown only in debug mode (`creditsTabAllowed()` in `client/src/main.js`). T-1 keeps it out of the **bottom** nav even then (desktop nav and the Home tile only), so a phone never shows seven items. Six visible bottom-nav items is one more than today: T-1 checks the fit at 320 px and 375 px in a real browser (tap targets at least 44 px, labels not truncated) before shipping.

### 5.2 Teams list (top view)

One card per Team, ordered by the soonest upcoming shared class:

- A mini mascot in the Team's current state (§5.4) plus the Team name.
- **Today line:** "3 classes today · 1 done", or "Quiet day" / "All done for today 🏆".
- **Hottest line** (one only): "2 doing 08:30 Train · JAB Shoreditch". This shows only when two or more members share a class the viewer can see.
- An avatar stack of the members active today.
- A badge with the pending-request count, for those who can approve (Captains, or every member if the Team allows it).
- The viewer's own state, if paused: "You're hidden from this Team".

Primary action: **Create Team**. Secondary: **Join with a link** (a paste field, since iOS PWAs often open shared links in Safari rather than the installed app, §7).

Empty state: the mascot, one sentence on what Teams are, and Create plus Join.

### 5.3 Team dashboard

The widget order is deliberate: today's state first, coordinating classes second, everything else after. It reuses `widget-registry.js` so each widget loads and fails independently, as Home's do.

1. **Header:** the mascot (large) plus the Team name, a one-line state ("Ana and Sam are in class now"), and Share link / **Manage** buttons (§5.7).
2. **Now and next:** who is in class right now (with a progress ring to the class end), then the next one or two classes today. This disappears when there is nothing today.
3. **Classes together** (horizontal, chronological): classes where two or more members are booked. The card shows the class, time, gym, avatar stack and spots left. The CTA follows the viewer's state: **Book** (existing quick-book flow), **Join waitlist**, **Auto-book** (not released yet, so it opens with the release time shown), **You're in ✓**, or **Turn on *Gym***. This is the feature's main reason to exist; it converts a group chat's "who's going to 8:30?" into a single tap.
4. **Week view:** the Home week strip, with one coloured dot per member per day (members get colours from the deterministic palette in §5.5). Tapping a day lists that day's shared classes, grouped by class, not by member.
5. **Members:** avatar, name, a small Captain mark, "4 this week · 11 in Nov", next class (if shared), gym chips. Whoever can approve sees a "2 requests" row at the top, which opens the approval sheet. Tapping a member opens their Team-scoped profile: upcoming and recent classes as they shared them.
6. **Team stats:** classes this week versus last, an active-days streak ("the Team has trained 5 days running"), discipline mix, and the busiest times. A leaderboard appears only if friendly competition is on (§3), because rankings put pressure on the least active member, which is the opposite of a supportive group.
7. **Moments** (later phase): milestones ("Sam's 100th class"), "first class together", and new members joining.

Additional suggestions beyond the brief, sorted into phases in §8:

- **Teammate avatars in the Timetable:** a small avatar stack on any class teammates are booked into, across all Teams. This is probably more valuable than the dashboard itself, because it reaches people at the moment they decide.
- **A Home widget:** "Your Teams today", the top two Teams' today lines.
- **Book next to:** when a teammate shares their spot, the spot picker highlights the seats either side. This builds on `companion-slots.js`.
- **Pushes**, opt-in per Team and conservative by default: a join request (to whoever can approve), request approved (to the requester), and "Ana booked 08:30 Train, a class you're in". Never "Ana booked a class" in general, since that is spam in a ten-person Team.

### 5.4 Team mascot states

The state is derived from the shared classes today (in each class's own zone), across all members including "+N at other gyms":

| State | Condition | Art |
|---|---|---|
| Sleeping | Before 05:00 or after 22:00, nothing in progress | new |
| Resting | No shared classes today | new |
| Warming up | Classes today, none started | `droplet.gif` or new |
| Exercising | At least one member in class now | `bike.png` / `dumbbell.png` (by discipline when known) |
| Cooling down | Some classes done, more to come | new |
| Champion | Everything done today (one or more classes) | new |

A mini ring around the mascot shows the share of today's classes completed. The art needs four new poses in the existing character style (from `characters/`). This is user-dependent asset work, and T2 can launch with the existing three plus a CSS-dimmed "resting" fallback.

### 5.5 Identity and avatars

- **Name:** the account `firstName` setting (already captured by `name-capture.js`) plus the last initial if two members share a first name. This is resolved per Team, so "Sam" is unique within it. An optional per-Team nickname is a later nicety.
- **Avatar:** initials on a colour circle, the colour chosen deterministically from a fixed accessible palette (contrast-checked in light and dark). The colour is assigned per Team so no two members in one Team clash, and stored on the membership so it is stable.
- **Photo upload is later (T6),** because it brings storage, size limits, EXIF and GPS stripping (metadata in a photo is itself a location leak), server-side re-encoding, and moderation for a reported image.

### 5.6 Create, invite, request and approve flows

1. **Create:** name (required, at most 40 characters), an optional emoji or colour, then the sharing sheet for your own membership. The Team is created with you as its first Captain and a link ready to copy or share via the native share sheet.
2. **Open link** (`/t/<token>`): if signed out, log in or sign up, then resume. Once signed in: "Request to join *Team name*?", the sharing sheet, then **Send request**. It is idempotent: re-opening the link shows "Request pending · Withdraw".
3. **Approve:** Captains (or every member, if the Team allows it) see the requester's display name and avatar, plus "Requested via link · 2 h ago", with **Approve** / **Decline** / **Decline and block**. If several Teams are pending, they can act from the Teams list badge.
4. **Outcomes:** approved means a push plus the Team appearing in the list. Declined shows "Your request wasn't accepted" and starts a 7-day cooldown before the same person can request again. Blocked looks the same as declined to the requester. Requests expire after 14 days.
5. **Link management** (Captains): copy, share, **Reset link** (rotate), or turn off joining.

### 5.7 Manage page

One page, opened from the dashboard header, full-screen on mobile via `modal-nav.js` (the mobile full-screen page helper). Sections appear according to the viewer's role:

- **Everyone:**
  - **My sharing:** the §3 sheet for this Team, plus Pause.
  - **Leave Team:** a confirmation that names what stops being shared.
- **Captains only:**
  - **Members:** for each member, **Make Captain** / **Remove as Captain** and **Remove from Team**.
  - **Join requests:** the approve / decline / block list.
  - **Invite link:** copy, reset, turn joining on or off.
  - **Team:** name, emoji, "Any member can approve requests", friendly competition, and **Delete Team** (typed confirmation of the Team name).

## 6. Roles and limits

- **Captain:** ownership is **shared equally by every Captain** (D4, decided). There is no single owner and no Captain above another. Any Captain can do everything:
  - approve, decline or block requests
  - remove members
  - make another member a Captain, or remove a Captain's status (their own included)
  - rename the Team
  - reset or disable the link
  - change Team settings
  - delete the Team
- **Member:** view the Team, change their own sharing, pause, leave. If the Team setting allows it, members can also approve requests.
- **There is always at least one Captain:**
  - The server refuses to demote or remove the last Captain.
  - If the last Captain leaves, or deletes their account, the longest-standing member is made Captain automatically, and the Team sees "Ana is now a Captain".
  - A Team with no members is deleted.
- Equal Captains can remove each other. That is the accepted cost of shared ownership. Every role change and removal is shown to the Team ("Sam removed Ana as Captain") and written to the audit log, so nothing happens silently.
- **Limits** (keep it small and bound the cost; D6):
  - 16 members per Team
  - 20 Teams per account
  - 50 pending requests per Team
  - 10 join requests per hour per account

  An approval that would exceed 16 members is refused, with "Team is full".

## 7. Server design

### 7.1 Data model (new tables in the canonical schema block)

```
teams              id, invite_token_hash UNIQUE, invite_enabled, invite_rotated_at,
                   name, emoji, approval_policy ('captains'|'any'), competition_enabled,
                   created_by, created_at, updated_at
team_members       team_id, user_id, is_captain, colour_index,
                   share_json, paused_until, joined_at, UNIQUE(team_id, user_id),
                   FK users ON DELETE CASCADE, FK teams ON DELETE CASCADE
team_join_requests id, team_id, user_id, status ('pending'|'approved'|'declined'|'withdrawn'|'expired'),
                   blocked, created_at, decided_by, decided_at
```

- Store only a **hash** of the invite token. The raw token exists only in the URL.
- `share_json` is validated against one schema module (`server/team-sharing.js`), which also owns the defaults. Unknown keys are dropped, and a missing key resolves to the **private** value. This is deliberately the opposite of the capability flag rule (unknown means on): capabilities fail safe by showing, but sharing must fail safe by hiding.
- Module boundary, following the house style: `server/teams.js` is the ONLY reader and writer of the three tables, and `server/team-projection.js` is pure (rows in, payload out) so it can be unit tested without a database.

### 7.2 Where the data comes from, and keeping it fresh

The projection reads stored data and never calls a gym per view:

- Upcoming classes come from `booking_cache`. Waitlists come from `waitlist_cache`. The auto-book queue comes from `auto_bookings` (pending). Recent classes and counts come from `class_history` (H-0).

**Requirement (decided 2026-11-04): every account's upcoming classes and waitlists are fetched and refreshed periodically in the background, whether or not the member opens Dibs, and whether or not they booked through Dibs.** Teams depends on this, and so do reminders, the calendar feed and Home.

**Gap found in the code:** today `poller.refreshBookingCaches()` refreshes `booking_cache` only for members with a push subscription and cancellation reminders enabled. Calendar-feed users are refreshed by `calendar.js` instead. Everyone else's cache moves only when their own client syncs it. So a member with neither feature, who books on the gym's website and never opens Dibs, shows no upcoming classes.

**T-B, universal background booking sync** (a prerequisite of T-2; can ship before Teams). It changes `refreshBookingCaches` from opt-in to universal:

- **Who:** every account, for every linked gym with `account_enabled`, regardless of push, reminder or Teams state. Disabled gyms and links stay untouched (`gymOutbound.isOutboundBlocked`), as do throttled gyms (`rate-limit-backoff.js`). A link flagged `needs_relogin` or with suspended relogin is skipped and keeps its rows.
- **What:** the waitlists are refreshed alongside `booking_cache`, because §3 shares them.
- **One writer per user and gym:** `calendar.js` and the poller both write `booking_cache` today. Make one sync function the only writer, and have the calendar build its snapshot from that function's result, so the two jobs neither double-fetch nor overwrite each other's enrichment.
- **Cadence:**
  - every 2 h for members in a Team that can see their upcoming classes
  - every 6 h for everyone else (today's cadence)
  - jittered and staggered per gym, as now
  - an immediate refresh after any book, cancel or waitlist action through Dibs
- **Staleness:**
  - A failed fetch keeps the last good rows; it never empties them.
  - Each row set records `synced_at`.
  - The Team member card shows "Updated 3 h ago" once data is older than the cadence, so stale data never passes as live.
- **Cost:** provider calls grow with accounts × enabled gyms, not with Teams or page views; a member in five Teams costs the same as one in one Team. Before switching it on in production, measure the call count per cycle against each gym's throttling (the `/metrics` upstream counters). If it is too high, lengthen the non-Team cadence first.
- **Tests:**
  - A suite asserting that an account with no push, no calendar and no Teams still gets its cache refreshed.
  - Disabled, throttled and needs-relogin gyms are skipped and keep their rows.
  - A failure for one gym leaves the other gyms' rows intact.

Book, cancel and waitlist actions made through Dibs also invalidate the member's Teams' projections.

### 7.3 Projection rule

For viewer V, Team T and member M ≠ V, include item i only if all of these hold:

`V ∈ T.members` ∧ `M ∈ T.members` ∧ `M` is not paused ∧ the item's category is shared in `M.share` ∧ the item's gym is in `M.share.gyms` ∧ `M`'s link to that gym is enabled ∧ the item is not cancelled or penalised. Then show details if V has that gym linked, otherwise count it in "+N at other gyms".

Gym zones come from `zoneOfGym(gymId)`, and every key is `gymId:eventId` (event ids collide across gyms; see WP-G, the gym-scoping rule).

### 7.4 API (all authenticated, all through `teams.js` and the projection)

```
GET    /api/teams                         list + today summaries (for the Teams tab)
POST   /api/teams                         create
GET    /api/teams/:id                     dashboard projection
PATCH  /api/teams/:id                     rename / emoji / policies (Captain)
DELETE /api/teams/:id                     delete (Captain)
POST   /api/teams/:id/invite/rotate       new link (Captain)
PUT    /api/teams/:id/invite              { enabled } (Captain)
GET    /api/teams/invite/:token           preview: { name, emoji, myRequestStatus } only
POST   /api/teams/invite/:token/request   { share }  → pending
DELETE /api/teams/invite/:token/request   withdraw
GET    /api/teams/:id/requests            Captains (or any member if the Team allows)
POST   /api/teams/:id/requests/:rid       { decision: approve|decline|block }
PUT    /api/teams/:id/me                  share settings / pause
DELETE /api/teams/:id/me                  leave (the last Captain leaving promotes the longest-standing member)
PUT    /api/teams/:id/members/:memberRef  { captain: true|false } (Captain; refuses to remove the last Captain)
DELETE /api/teams/:id/members/:memberRef  remove (Captain); memberRef is a per-Team opaque id, never a user id
GET    /api/privacy/sharing               the "Who can see my classes" overview
```

- Any authorisation failure (not a member, or an unknown Team) answers **404, never 403**, so ids and tokens cannot be probed. Invite endpoints are rate limited per IP and per account.
- A Team payload carries no `userId`. Members are addressed by a per-Team opaque `memberRef`.
- The `/t/<token>` route serves the SPA shell with **generic** Open Graph tags (principle 4) and `Referrer-Policy: no-referrer`, so the token never leaks to third-party images.
- Admin panel: a Team count per user, and Team detail **without** member class data (the operator has no product need for it). Audit-log rows (C7-3) record create, delete, Captain changes (including automatic promotion), member removal and blocks.

### 7.5 Account lifecycle

`DELETE /api/auth/me` cascades memberships and requests. Before that, any Team losing its last Captain promotes its longest-standing remaining member. Unlinking a gym removes its items from every projection on the next request (the projection checks the link live). Config export and import includes the member's own share settings but never other members' data.

## 8. Phases

Each phase follows [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md): verify in code and a real browser first, then change, then re-verify. Use IDs `T-n` (the Teams workstream).

| ID | Phase | Scope | Exit criteria |
|---|---|---|---|
| **T-0** | Design | Mobile and desktop mock-ups of the Teams list, dashboard, Manage page, join flow and sharing sheet in the current visual language. Brief the mascot poses. (§9 decisions are settled.) | The user approves the mock-ups |
| **T-B** | Universal background booking sync | §7.2: every account and every enabled gym refreshed in the background, a single writer of `booking_cache`, waitlists included. Independent of the Teams UI; can ship first. **Progress 2026-11-04 (branch `teams`):** built as `server/booking-sync.js` (single background writer; calendar consumes it; 2 h priority predicate stubbed empty for T-2; 3 h kept for calendar-feed users; per-(user, gym) `booking_sync_state`; `/api/health` + `/metrics` counters). Suite `test-booking-sync.js` green. **Not yet done:** measured upstream calls per cycle on dev and prod; not deployed. | The §7.2 suite, plus measured upstream calls per cycle on dev, then on prod |
| **T-1** | Membership core | Schema, `teams.js`, create, invite link, request, approve or decline or block, leave, remove, Captains (grant, revoke, last-Captain guard, auto-promotion), 16-member limit, share settings, the Manage page, Settings → Privacy overview, Teams in the nav (six items). The Teams tab shows Teams and members only (no class data). **Progress 2026-11-04 (branch `teams`), server side only:** schema (`teams`, `team_members`, `team_join_requests`, random text ids), `server/teams.js` (sole table owner), `server/team-sharing.js` (D3 defaults; missing key = private), `server/teams-routes.js` (all §7.4 routes, invite limiters per IP and per account), `GET /t/:token` generic shell with `Referrer-Policy: no-referrer`, invite tokens scrubbed from request logs, audit rows (create, delete, Captain grant/revoke/auto-promote, removal, block), last-Captain auto-promotion on leave and on account deletion (self and admin), admin Team count per user, own share settings in config export/import. Suite `test-team-membership.js` green. Deviations: a join request also stores the requester's `share_json` (consent, applied on approval); a request that sends a partial share gets private for omitted keys, while sending none gets the D3 defaults; the raw invite token is returned only on create and rotate (it is never stored, so a Captain cannot re-copy an old link). **Not yet done:** all client UI (Manage page, Privacy overview, nav, `/t/` client routing) waiting on T-0 mock-ups; the two-account browser run and the 320/375 px nav check; the "Ana is now a Captain" Team-visible notice (needs an activity feed). | `test-team-membership.js` (Captain rules, last-Captain guard, full Team, cooldowns, token rotation, 404-not-403, opaque refs), a browser run of the two-account join flow, and a bottom-nav check at 320 px and 375 px |
| **T-2** | Projection and Teams list | Requires T-B. `team-projection.js`, the 2 h cadence for shared members, `GET /api/teams` today summaries, mascot state machine (pure, unit tested), Teams list cards. | **`test-team-privacy.js`**: a multi-user, multi-gym matrix in which every share toggle, pause, unlinked gym, disabled gym, cancelled booking and removed member is asserted absent from the payload (the Teams counterpart of `test-gym-isolation.js`) |
| **T-3** | Team dashboard | Header, Now and next, Classes together with booking CTAs via existing flows, Week view, Members. | Browser run with three dev accounts across both mock gyms (Psycle and JAB), mobile and desktop, light and dark |
| **T-4** | Stats | Counts, streaks, mix, busiest times. Opt-in competition. | Unit tests on aggregation, using the zones of the class's gym |
| **T-5** | Reach | Timetable avatar stacks, Home "Your Teams today" widget, the three pushes (with per-Team toggles). | Push dedupe keys in `sent_notifications`. A browser check of the timetable with avatars at 375 px |
| **T-6** | Later | Profile photos (§5.5), Book next to, Moments, per-Team nicknames. | Separate specs |

T-1 and T-2 are the privacy-critical core; they should be reviewed (`/code-review high`) before T-3 builds UI on them.

## 9. Decisions (settled by the user, 2026-11-04)

| ID | Question | Decision |
|---|---|---|
| D1 | Navigation | Home · Timetable · Bookings · Auto-Book · Teams · Settings. Credits is hidden for all users and not expected back. |
| D2 | Classes at gyms the viewer hasn't linked | Details hidden; counted as "+N at other gyms" in the mascot and totals |
| D3 | Sharing defaults | Everything on except **spot numbers** and the **auto-book queue**, which are opt-in |
| D4 | Roles and approval | **Captains** with equal, shared ownership. Captains approve by default; a Team setting lets any member approve. The Manage page (§5.7) covers members' own sharing and leaving, and Captains' member and Captain management. |
| D5 | Visibility of a new member's earlier history | Counts and the last 30 days are visible on join |
| D6 | Team size cap | 16 members for now |
| D7 | Name | Teams |
| — | Background sync | Every account's classes are refreshed in the background regardless of app use (§7.2, T-B) |
