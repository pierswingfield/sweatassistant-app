# Work plan: Teams (shared upcoming classes for small groups)

**Status:** In progress on branch `teams` (T-0 design, T-B background sync, T-1 membership core, T-2 projection/Teams list, T-3 dashboard and T-4 stats built; T-4 review and the owner's call on §8.1 next; nothing pushed or deployed). Handover below. Originally proposed 2026-11-04. Expands F-3 (social class sharing: "who's going", friend graph). The decisions in §9 were settled by the user on 2026-11-04; the T-0 mock-ups (the design phase) were approved after round 3 on 2026-11-04, and every change from the owner's feedback is recorded here.

## Handover (status as of 2026-11-06)

**Where the code is**
- Branch `teams`, worktree `/home/ubuntu/AI Projects/psycle chrome/App-teams`; T-4 sits on 9118075. Branched from `master`; `master` merged in at bd76b7a (brings the trust-proxy fix 35a98b8 and master commits up to b98cccc). Nothing pushed, nothing deployed.
- Tests after T-4: 110/110 server suites; client 106 files / 852 tests.

**Done (phase = what it is)**
- T-B, universal background booking sync (54d8e0d; review fixes 5631ced): every account's bookings and waitlists refreshed in the background; `booking-sync.js` is the single writer; cadence 2 h for Team members, 6 h others, 3 h calendar-feed users.
- T-1 server, the membership core (0e7c0d8; fixes 28d895f, 6fb45f4): Captains-only approval, pinning, neutral `notMember` answer.
- T-0, the mock-ups: approved after three rounds (51d6ea4, 85cdf60, 0b83d39), in `Documentation/Workstreams/teams-mockups/`.
- T-1 UI part A (444656e, be9b6e1, 02a747a; fixes d7e645e): six-item nav, Teams list, Team page shell, Manage, join-link page, Settings > Privacy.
- T-1 part B (8c2f441, 43fb229, 4e7432f, ca3e6b2; fixes 3a77491): first and last names (shared validator plus confusable skeleton), onboarding Teams perk/CTA/auto-upgrade note, landing Teams section.
- T-4, Team stats (2026-11-06): classes this week ("+3 on last week"), Team streak, and a carousel of busiest days, gym mix and busiest times. The server aggregates in `team-stats.js`; the mascot ring now counts the elapsed share of a class in progress. Friendly competition and spot numbers are NOT built: the proposal for the owner is §8.1. Browser evidence: `teams-mockups/screens/t4-*.png`.
- T-3, the Team dashboard (2026-11-06): Today's workouts, This week, Classes together and Members; member `gyms`/`otherGym` chips and the Captain-only request count. Browser evidence: `teams-mockups/screens/t3-*.png`.
- T-2, projection and Teams list (68c6f37..72d7002; fixes 2fa27cf): `team-projection.js` privacy filter, `test-team-privacy.js` (33 checks), `team-mascot.js`, live Teams list. Client-pushed rows are never shown (`booking_cache.origin`); started-then-missing rows stay hidden until `class_history` confirms them (`missing_since`). Both new `booking_cache` columns use idempotent ALTERs; verified booting against a master-built DB.

**Next**
- T-4 review (`/code-review high`), and the owner's decisions in §8.1 (friendly competition: Team goal vs opt-in leaderboard; spot numbers: keep as built vs same-class only).
- Then T-5 (timetable Team chips, Home widget, pushes), T-6 (later items).

**Open items and owner decisions**
- Security audit findings are PAUSED by the owner (not Teams-specific):
  - High: app-wide unescaped gym data in `innerHTML`; unchecked instructor link schemes.
  - Medium: no security headers or CSP; JWTs not revocable on password change, reset or deletion; gym `session_json` stored plaintext, and backups on Google Drive are unencrypted (possibly including `jwt_secret`).
  - Low: shared admin/user JWT secret; login timing enumeration; `.ics` lone-CR escaping; no AES-GCM AAD or key-length check; SSE token in the query string.
- Teams-side lows still NOT done (checked at 2fa27cf): per-user+gym rate limit on forced booking syncs; `bookingMutationLimiter` on `POST /api/notify/booking-success`; index on `team_join_requests(status, created_at)`.
- Owner's mascot originals stay untracked in `characters/` (the app uses optimised copies under `client/public/characters/`). Do not commit them.
- `.env.example` gained `TRUST_PROXY` from the trust-proxy fix. Default is 1 hop in production (Cloudflare Tunnel), 0 otherwise, so prod `.env` needs nothing unless the app is exposed without the tunnel (then `TRUST_PROXY=0`). The dev twin (tailnet port 3005, no tunnel) inherits the production default. No new env var is required by Teams.
- Deploy prerequisite: none of this is deployed; deploy only from a clean `master` after merging `teams`. T-B still needs measured upstream calls per cycle on dev, then prod.

**How the work has been run**
- Orchestrated subagents, one dev agent at a time, each phase reviewed before the next.
- Real-browser checks use the owner's Chrome on CDP `127.0.0.1:9222`, tunnelled with `ssh -N -R 127.0.0.1:9222:127.0.0.1:9222 oracle`; the dev app is served on this host's Tailscale IP.

## 1. Outcome

A member can create or join small private groups, called **Teams** (a group chat, friends, a couple, a running club; at most 16 members). Inside a Team they can see who is doing which classes, find classes several members are already in, and book into them. Each member decides per Team exactly what they share, and the server enforces that decision.

Non-goals for this plan: public profiles, following strangers, discovering Teams by search, chat (the group chat already exists elsewhere, and a Team is its companion), and anything that books or cancels on someone else's behalf.

## 2. Privacy principles (these govern every later decision)

1. **The server projects, the client displays.** A viewer's response contains only what each sharer allowed for that Team and what the viewer may see. No client-side filtering of data the viewer has already received. One server function, `projectTeamFor(viewerId, teamId)`, produces every Team payload, and one suite pins it (§8).
2. **Consent per Team, shown in plain words.** Joining always passes through a "What you'll share with *Team name*" screen. You cannot join without seeing it. It can be changed later from the Team and from one account-level overview.
3. **A pending requester sees nothing.** Before approval, the requester sees the Team's name and mascot only: no member count, member names or activity.
4. **The invite link is a revocable secret, not the Team's identity.** The URL carries a random 128-bit token that is separate from the Team id (hash for lookup, encrypted copy for Captains only). Rotating it invalidates every old link without disturbing members. Link unfurls in chat apps (Open Graph tags) are generic ("You've been invited to a Team on Dibs"), because the people in a chat are not necessarily the people being invited.
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
| Spot numbers | "Bike 14", so friends can pick neighbouring spots | **Off** (most precise; opt in). Shown next to the name in attendee rows and as "teammate" seats in the spot picker (§5.3, proposed) |
| Auto-book queue | "Trying for 08:30 Train on Mon", useful for coordinating releases | **Off** (it reveals intent before a booking exists) |
| Friendly competition | The member appears in leaderboards and streaks | **Off** (Captains' team setting plus a member opt-in; proposed, §5.3) |
| Pause | Hide me from this Team until I unpause, or for 24 h or 7 days | Off |

- A newly linked gym joins "All my gyms" automatically, and the gym-link confirmation says "Shared with 2 Teams. Change." so this is never silent.
- Cancelled bookings disappear from the projection. Late-cancel and no-show statuses are **never** shared, whatever the settings.
- Settings → Privacy gets a **"Who can see my classes"** page that lists every Team, what it can see, and quick Pause/Leave actions. That is the one place to audit everything.

## 4. Viewer rule: other gyms

The brief says other members' classes at a gym the viewer has not linked are not shown. Refinement (D2, agreed): **details are hidden but the activity still counts.** The Team mascot, "8 classes today" and member counts include them, shown as "+2 at other gyms" with no gym, time or class. Without this, a JAB-only member sees a mascot resting while the Psycle members are all mid-class, and the dashboard misdescribes the Team's day. The sharer has already chosen to share that gym with the Team, so the count reveals nothing they withheld.

**Accepted residual disclosure (T-2 review, 2026-11-05):** the counts are not content-free. The mascot's state and ring, "N classes today" and the member counts move with each class's start and end, so a viewer can infer roughly *when* a teammate trains at a gym the viewer has not linked, and the bike or boxing pose can hint at the class type. The spec accepts this (the sharer already shared that gym with the Team), and the sharing sheet says so where the gyms choice is explained: "Teammates who don't use a gym still see that you trained, not the details." (`copy.js` `teams.gymsDesc`). To withhold even that, the member narrows "Gyms" or turns off Activity counts.

A gym the viewer has linked but paused (`user_gyms.account_enabled = 0`) is treated as linked for visibility. The Book CTA then says "Turn on *Gym* to book".

## 5. UX

### 5.1 Navigation

Teams gets its own primary destination (D1, decided). The Credits tab is hidden for all users and is not expected back, so the nav becomes **Home · Timetable · Bookings · Auto-Book · Teams · Settings** on both the iOS bottom nav and the desktop nav. Credits stays reachable from Home's credits tile. Credits is currently re-shown only in debug mode (`creditsTabAllowed()` in `client/src/main.js`). T-1 keeps it out of the **bottom** nav even then (desktop nav and the Home tile only), so a phone never shows seven items. Six visible bottom-nav items is one more than today: T-1 checks the fit at 320 px and 375 px in a real browser (tap targets at least 44 px, labels not truncated) before shipping.

### 5.2 Teams list (top view)

One card per Team, ordered by the soonest upcoming shared class. **Pinning:** a member of more than 3 Teams can pin up to 2 to the top of the list (per-member setting, stored server-side on `team_members.pinned`).

- A mini mascot in the Team's current state (§5.4) plus the Team name.
- **Today line:** "3 classes today · 1 done", or "Rest day" / "All done for today 🏆". When no more classes are booked today, the line shows a group insight or hint about tomorrow or the next class instead; if only one person is doing an upcoming class it may say "John doing 08:30 Train".
- **Hottest line** (one only): "2 doing 08:30 Train · JAB Shoreditch". This shows only when two or more members share a class the viewer can see.
- An avatar stack of the members active today.
- **No pending-request badge** (decided 2026-11-04; requests are visible only on the link page, §5.6).
- The viewer's own state, if paused: "You're hidden from this Team".

Primary action: **Create Team**, the only action. There is **no "Join with a link" paste field** (removed 2026-11-04): joining happens only by opening a Team's URL (§5.6).

Empty state (no Teams): the mascot, then exactly: "A Team is a private group (like friends, or a group chat) that can share their workout schedule and book in together. You can choose what your team sees, and what is private." Then **Create a Team** as the only action.

### 5.3 Team dashboard

The widget order is deliberate: today's state first, coordinating classes second, everything else after. It reuses `widget-registry.js` so each widget loads and fails independently, as Home's do.

1. **Header:** the mascot (large) plus the Team name and a one-line state ("Ana and Sam are in class now"). **Share link** and **Manage** sit in the page header next to the back link: icon-only on mobile (with `aria-label`s), text allowed on desktop. Share is shown to Captains only (§5.6).
2. **Today's workouts** (was "Now and next"): the Team's past (done), ongoing and upcoming workouts today, in time order. Ongoing ones carry a progress ring to the class end. Disappears when there is nothing today.
3. **This week**, directly after Today's workouts: the Home week strip, with no "one dot per member" text. The class list under the strip shows at most **3 classes**, then **See more** expands. It opens on the day with the next class (today or a future day). Each class row reads: time and name, then the instructor name, then a separator, then the attendees. There is **no "+N at a gym you haven't linked" text** in this widget and no space reserved for it (the count still feeds the mascot and totals, §4).
4. **Classes together** (horizontal, chronological): classes where two or more members are booked. It **reuses the Home screen's upcoming favourite-class card component**; the attendee avatars sit under the instructor, left of the CTA button. The CTA follows the viewer's state: **Book** (existing quick-book flow), **Join waitlist**, **Auto-book** (not released yet, so it opens with the release time shown), **You're in ✓**, or **Turn on *Gym***. This is the feature's main reason to exist; it converts a group chat's "who's going to 8:30?" into a single tap.
5. **Members:** avatar, name, a small Captain mark, "4 this week · 11 in Nov", next class (if shared), gym chips. **On mobile it pages horizontally, 4 members per page, with dot indicators.** A small sort-icon menu orders by **name**, **activity** (classes count) or **shuffle**; the choice is remembered per member per Team, client-side (`localStorage`). There is no requests row here (requests live in Manage). Tapping a member opens their Team-scoped profile: upcoming and recent classes as they shared them. With friendly competition on, personal streaks show on member cards.
6. **Team stats:**
   - **Classes this week:** "+3 on last week" (no bracketed total).
   - **Team streak** (was "The Team has trained 5 days running"): consecutive days on which at least one member completed a shared class, counting each class in its own zone.
   - **Graphs:** busiest **days of the week** (was busiest times), gym mix (coloured by gym branding) and busiest times. A **swipeable carousel with dot indicators on mobile** (order: busiest days, gym mix, busiest times); **side by side on desktop, no swiping**.
   - **Friendly competition** (*proposed, owner to confirm after mock-up*): a Team setting (Captains) plus a per-member opt-in (§3). Off by default. When on, the carousel gains a **Leaderboard** slide ranking opted-in members by classes this week and this month, and member cards show personal streaks. Non-opted members never appear in any ranking.
7. **Moments** (later phase): milestones ("Sam's 100th class"), "first class together", and new members joining.

**Spot numbers** (*proposed, owner to confirm*): shown only when that teammate has opted in (§3). (a) Next to their name in a class's attendee row, "Ana · Bike 14", on the dashboard and in the timetable. (b) In the spot picker when booking that class: their seats are highlighted as "teammate" seats ("Book next to", building on `companion-slots.js`).

Additional suggestions beyond the brief, sorted into phases in §8:

- **Teammate avatars and Team badges in the Timetable:** rows for classes teammates are going to show a **Team chip** containing the teammates' avatar circles, stacked horizontally and overlapping exactly like the collapsed timetable filter rail's gym-logo stack (`filter-rail.js` `gymStackZ`, the compact-state rules in `styles.css`: 26 px circles at an 8 px pitch, leftmost on top, no masking ring), followed by the Team name, e.g. [PW CJ Tuesday Riders] (decided 2026-11-04, round 3). With several Teams, show the first Team's name plus "+1" (e.g. "Run Club +1"), the rest in the row's expanded detail; sort Teams by pin, then name. This is probably more valuable than the dashboard itself, because it reaches people at the moment they decide.
- **A Home widget:** "Your Teams today", the top two Teams' today lines.
- **Pushes**, opt-in per Team and conservative by default: a join request (to Captains), request approved (to the requester), and "Ana booked 08:30 Train, a class you're in". Never "Ana booked a class" in general, since that is spam in a ten-person Team.

### 5.4 Team mascot states

The state is derived from the shared classes today (in each class's own zone), across all members including "+N at other gyms":

| State | Condition | Art |
|---|---|---|
| Sleeping | Before 05:00 or after 22:00, nothing in progress | `bed` |
| Resting | No shared classes today | `stretch` / `bed` |
| Warming up | Classes today, none started | `droplet.gif` / `dropletrun` |
| Exercising | At least one member in class now | A rotating pose (below) |
| Cooling down | Some classes done, more to come | `stretch`, rendered slightly smaller than the other poses so the whole image (mat and bottle) fits inside the ring without cropping |
| Champion | Everything done today (one or more classes) | `champion` |

**Mascot ring:** a mini ring around the mascot shows progress through **all** of the Team's classes today, unless the mascot sits on a single class's card, in which case it is that class's own progress.

**Exercising pose (decided 2026-11-04):** it rotates **daily**, deterministic per Team per date (a hash of Team id and the date in the viewer's zone, so every member sees the same pose that day), chosen from: dumbbell, running, handstand, skip, boxing, bike.

- **bike** is eligible only on a day with a cycle/ride class; **boxing** only on a day with a boxing class. The others are always eligible.
- **Centralised and data-driven:** one module (`client/src/ui/mascot-poses.js`) holds a registry of poses, each with an id, asset and an eligibility rule over the day's classes. Callers ask for the pose for (Team, date, classes) and never name a pose. A new pose is a registry entry plus an asset, with no caller changes. Unit tested for determinism, eligibility and fallback (if nothing is eligible, dumbbell).

**Assets:** the owner's new art is in `/characters/` on this branch (27 files). New and untracked: `bed.png`, `bed_alpha.png`, `boxing.png`, `boxing_alpha.png`, `champion.png`, `champion_alpha.png`, `dropletrun_alpha.png`, `dumbbell_alpha.png`, `handstand.png`, `handstand_alpha.png`, `skip_alpha.png`, `smoothie_alpha.png`, `stretch.png`, `stretch_alpha.png`. Already tracked: `bike.png`, `bike_alpha.png`, `droplet.png`, `droplet_#FAF4F0.png`, `droplet_alpha.gif`, `droplet_alpha.png`, `dropletrun.png`, `dropletrun_#FAF4F0.png`, `dropletrun_#FAF4F0_video.mp4`, `dropletrun_#FAF4F0_video.webm`, `dumbbell.png`, `icon_template.png`, `skip.png`, `smoothie.png`. `boxing_alpha.png` was added on 2026-11-04 (round 3); `boxing.png` itself is a JPEG with a .png name. There are no running/skip/handstand variants beyond those listed.

**Task (asset prep, before T-2):** crop to the figure with consistent padding, use the transparent `_alpha` versions as sources, and web-optimise (WebP or optimised PNG at 1x/2x, a few KB each, the large originals stay out of `client/public`), then put them under `client/public/characters/`. Boxing uses `boxing_alpha.png`.

### 5.5 Identity and avatars

- **Name:** the account first name, shown alone unless two members of the Team share it, then first name plus the last initial from the account’s real last name (§5.8 captures it). This is resolved per Team, so "Sam" is unique within it. An optional per-Team nickname is a later nicety.
- **Avatar:** initials on a colour circle, the colour chosen deterministically from a fixed accessible palette (contrast-checked in light and dark). The colour is assigned per Team so no two members in one Team clash, and stored on the membership so it is stable.
- **Photo upload is later (T6),** because it brings storage, size limits, EXIF and GPS stripping (metadata in a photo is itself a location leak), server-side re-encoding, and moderation for a reported image.

### 5.6 Create, invite, request and approve flows

Joining is **strictly via the URL** (decided 2026-11-04).

1. **Create:** name (required, at most 40 characters), an optional emoji or colour, then the sharing sheet for your own membership. The Team is created with you as its first Captain and a link ready to copy or share via the native share sheet.
2. **Open link** (`/t/<token>`): if signed out, log in or sign up, then resume. Once signed in: "Request to join *Team name*?", the sharing sheet, then **Send request**. It is idempotent: re-opening the link shows "Request pending · Withdraw". **The link page is the only place a pending request is shown**: not in the Teams list, not in the Privacy overview, and the join response carries only what the link page needs.
3. **Approve:** Captains see the requester's display name and avatar, plus "Requested via link · 2 h ago", with **Approve** / **Decline** / **Decline and block** (Manage → Join requests). There is no badge on the Teams list.
4. **Outcomes:** approved means a push plus the Team appearing in the list. Declined starts a 7-day cooldown before the same person can request again; removal starts the same cooldown; blocked is permanent. **A declined, blocked or removed person opening the link during the cooldown sees only "You aren't a member of this Team."** (never "not accepted" or "declined", so the three cases look identical). After the cooldown (unless blocked), or once the request has expired (14 days), the link offers **Request to join** again.
5. **Link management** (Captains): **Share** (copy or native share) in the dashboard header (§5.3); **Reset link** and **Turn off joining** live inside Manage → Team settings as items, not as a widget.

### 5.7 Manage page

One page, opened from the dashboard header, full-screen on mobile via `modal-nav.js` (the mobile full-screen page helper). Sections appear according to the viewer's role. There is no invite-link section on this page: Share sits in the dashboard header and Reset link / Turn off joining are Team settings items (§5.6).

- **Everyone:**
  - **My sharing:** the §3 sheet for this Team, plus Pause and the friendly-competition opt-in (only shown when the Team has it on).
  - **Pin to top** (only for members of more than 3 Teams; at most 2 pinned).
  - **Leave Team:** a confirmation that names what stops being shared.
- **Captains only:**
  - **Members:** for each member, **Make Captain** / **Remove as Captain** and **Remove from Team**.
  - **Join requests:** the approve / decline / block list.
  - **Team settings:** name, emoji, friendly competition (Captains), **Reset link**, **Turn off joining**, and **Delete Team** (typed confirmation of the Team name). The "Any member can approve requests" setting is removed.

**Resolved 2026-11-04:** the "invite link widget" the owner asked to remove was the Teams list's "Join with a link" paste field, which is gone (§5.2). Captains keep link management: Share in the dashboard header, and Reset link / Turn off joining in Team settings.

### 5.8 Onboarding, names and landing page

Part of T-1 UI unless noted. Decided 2026-11-04.

- **Name capture:** collect **first and last name**, prefilled from the gym profile data, both editable. This replaces the first-name-only behaviour of `name-capture.js`. Teams display first name, plus last initial on a clash (§5.5).
- **Onboarding: no separate Teams step** (decided round 3, 2026-11-04). Teams is added to the onboarding feature list on the welcome screen, and the final setup page ("Make it yours") gets a Teams card with a **Create or join a Team** button. Because joining is by link only, that button opens the Teams tab, whose empty state explains joining.
- **Auto-upgrade step:** if the user already has at least ONE gym set up for auto-upgrade, the "enable auto-upgrade for all gyms" tickbox is replaced by a note that they can change it in Settings at any time.
- **Landing page (the M workstream, `M-landing-page.md`):** gets a Teams section with details (private groups, what you choose to share, booking together). Approved copy (round 3): heading "Bring your workout plans out of the group chat."; intro "On Dibs, a Team is a private group to help you train with your people. Members can share and co-ordinate their workout schedule with friends, partners and more."; cards "Join up to 16 people in a private group, to share your workout plans and stay motivated.", "You can choose to share the information you're comfortable with. For each group, you choose whether your upcoming classes, chosen spots, and activity history are visible." and a booking-together card ending "Grab the spot next to theirs." The hero gains a paragraph after "A concierge for every gym you train at: …": "Create and join a private Team to stay in sync with your buddies." Cross-referenced from [M-landing-page.md](M-landing-page.md). Not part of T-1 gating; it ships with the Teams launch.

## 6. Roles and limits

- **Captain:** ownership is **shared equally by every Captain** (D4, decided). There is no single owner and no Captain above another. Any Captain can do everything:
  - approve, decline or block requests (Captains only, no policy setting)
  - remove members
  - make another member a Captain, or remove a Captain's status (their own included)
  - rename the Team
  - reset or disable the link
  - change Team settings
  - delete the Team
- **Member:** view the Team, change their own sharing, pause, pin (when in more than 3 Teams), leave. Members never approve requests; only Captains do.
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
teams              id, invite_token_hash UNIQUE, invite_token_enc, invite_enabled, invite_rotated_at,
                   name, emoji, competition_enabled,
                   created_by, created_at, updated_at
team_members       team_id, user_id, is_captain, colour_index, pinned (0|1),
                   share_json, paused_until, competition_opt_in, joined_at, UNIQUE(team_id, user_id),
                   FK users ON DELETE CASCADE, FK teams ON DELETE CASCADE
team_join_requests id, team_id, user_id, status ('pending'|'approved'|'declined'|'withdrawn'|'expired'),
                   blocked, created_at, decided_by, decided_at
```

- `approval_policy` is **removed** (decided 2026-11-04): only Captains approve. **Code change pending (T-1 follow-up):** drop the column and its handling in `server/teams.js`, `teams-routes.js` and `test-team-membership.js`. Pins are per member, server-side, capped at 2, and only allowed when the member is in more than 3 Teams (the server re-checks both on every write).
- The invite token is stored as a **SHA-256 hash for lookup** plus an **encrypted copy** (`crypto.js`, AES-256-GCM, `ENCRYPTION_KEY`) so a Captain can re-copy the current link (§5.6). Only Captains can read it (`GET /api/teams/:id/invite`); it is never logged or audited; rotation replaces both.
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

**Started classes the next sync omits (T-2 review, 2026-11-05).** A gym's upcoming list drops a booking once the class starts, but it equally drops one that was late-cancelled, and the list alone cannot say which. `replaceBookingCache` keeps such a started server row for 24 h (`RETAIN_STARTED_MS`) and stamps it `missing_since`; the stamp clears if the gym lists the booking again. **Rule:** a row with `missing_since` is not shown, not counted and does not move the mascot, ring or "today" totals in any Team projection until `class_history` holds the same gym-qualified booking id (`gymId:bookingId`) with a counted status (`attended` or `unconfirmed`). For a gym whose past list has no attendance signal (CodexFit: every past booking is `unconfirmed`, and the list carries no cancelled rows), presence in the past-bookings list is the confirmation and absence is not. A late cancel (MarianaTek `late-cancel`, or simply absent at CodexFit) therefore never appears as done. The member's own non-Team views (reminders, calendar, Home) read the row as before. The trade-off: between the class starting and the next history sync (up to 6 h), a class the gym has already dropped from its upcoming list drops out of the Team's day; a class still in the latest sync shows normally.

**Booking ids are gym-qualified everywhere origin is decided.** When a client push is merged, the server rows it carries through are keyed `gymId:bookingId`, never by bare id: two gyms can both publish booking 7777, and a bare key let a client-only push to gym B inherit gym A's `origin = 'server'` and reach a Team.

### 7.3 Projection rule

For viewer V, Team T and member M ≠ V, include item i only if all of these hold:

`V ∈ T.members` ∧ `M ∈ T.members` ∧ `M` is not paused ∧ the item's category is shared in `M.share` ∧ the item's gym is in `M.share.gyms` ∧ `M`'s link to that gym is enabled ∧ the item is not cancelled or penalised. Then show details if V has that gym linked, otherwise count it in "+N at other gyms".

Gym zones come from `zoneOfGym(gymId)`, and every key is `gymId:eventId` (event ids collide across gyms; see WP-G, the gym-scoping rule).

### 7.4 API (all authenticated, all through `teams.js` and the projection)

```
GET    /api/teams                         list + today summaries (for the Teams tab); pinned first; no pending counts
POST   /api/teams                         create
GET    /api/teams/:id                     dashboard projection
PATCH  /api/teams/:id                     rename / emoji / competition (Captain); no approval policy
DELETE /api/teams/:id                     delete (Captain)
POST   /api/teams/:id/invite/rotate       new link (Captain)
GET    /api/teams/:id/invite              { url, enabled } (Captain; the current link, decrypted)
PUT    /api/teams/:id/invite              { enabled } (Captain)
GET    /api/teams/invite/:token           link page state only: { name, emoji, state: invite|pending|not-a-member|expired }. "not-a-member" covers declined, blocked and removed during cooldown. This is the only place a pending request is visible.
POST   /api/teams/invite/:token/request   { share }  → pending
DELETE /api/teams/invite/:token/request   withdraw (needs a working token)
DELETE /api/teams/requests/:requestId     withdraw own pending request by id (no token; works after the link is rotated or disabled; 404 otherwise)
GET    /api/teams/:id/requests            Captains only
POST   /api/teams/:id/requests/:rid       { decision: approve|decline|block } (Captains only)
PUT    /api/teams/:id/me                  share settings / pause / competition opt-in
PUT    /api/teams/:id/pin                 { pinned: bool } per-member pin; refused beyond 2 pins or with 3 or fewer Teams (409 PIN_LIMIT)
DELETE /api/teams/:id/me                  leave (the last Captain leaving promotes the longest-standing member)
PUT    /api/teams/:id/members/:memberRef  { captain: true|false } (Captain; refuses to remove the last Captain)
DELETE /api/teams/:id/members/:memberRef  remove (Captain; optional { block: true }; removal starts the same 7-day cooldown as a decline); memberRef is a per-Team opaque id, never a user id
GET    /api/privacy/sharing               the "Who can see my classes" overview
```

- Any authorisation failure (not a member, or an unknown Team) answers **404, never 403**, so ids and tokens cannot be probed. Invite endpoints are rate limited per IP and per account.
- Rotating or disabling the link leaves pending requests intact: Captains can still approve or decline them, and the requester can withdraw by request id (`requestJoin` returns it; the Privacy overview never lists pending requests).
- A Team payload carries no `userId`. Members are addressed by a per-Team opaque `memberRef`.
- The `/t/<token>` route serves the SPA shell with **generic** Open Graph tags (principle 4) and `Referrer-Policy: no-referrer`, so the token never leaks to third-party images.
- Admin panel: a Team count per user, and Team detail **without** member class data (the operator has no product need for it). Audit-log rows (C7-3) record create, delete, Captain changes (including automatic promotion), member removal and blocks.

### 7.5 Account lifecycle

`DELETE /api/auth/me` cascades memberships and requests. Before that, any Team losing its last Captain promotes its longest-standing remaining member. Unlinking a gym removes its items from every projection on the next request (the projection checks the link live). Config export and import includes the member's own share settings but never other members' data.

## 8. Phases

Each phase follows [AGENT_PROTOCOL.md](AGENT_PROTOCOL.md): verify in code and a real browser first, then change, then re-verify. Use IDs `T-n` (the Teams workstream).

| ID | Phase | Scope | Exit criteria |
|---|---|---|---|
| **T-0** (Done) | Design | **Approved 2026-11-04** after three rounds of owner feedback. Mock-ups: `Documentation/Workstreams/teams-mockups/index.html` (screens in `teams-mockups/screens/`). Round 3 changes: smaller Cooling-down mascot, `boxing_alpha.png`, teammate avatars inside the timetable Team chip using the filter-rail stack, Teams in the onboarding feature list plus a "Create or join a Team" button on the final setup page (no separate Teams step), and the landing copy in §5.8. | Done: the user approved the mock-ups |
| **T-B** (Built, not deployed) | Universal background booking sync | §7.2: every account and every enabled gym refreshed in the background, a single writer of `booking_cache`, waitlists included. Independent of the Teams UI; can ship first. **Progress 2026-11-04 (branch `teams`):** built as `server/booking-sync.js` (single background writer; calendar consumes it; 2 h priority predicate stubbed empty for T-2; 3 h kept for calendar-feed users; per-(user, gym) `booking_sync_state`; `/api/health` + `/metrics` counters). Suite `test-booking-sync.js` green. **Not yet done:** measured upstream calls per cycle on dev and prod; not deployed. | The §7.2 suite, plus measured upstream calls per cycle on dev, then on prod |
| **T-1** (Built, not deployed) | Membership core | Schema, `teams.js`, create, invite link, request, approve or decline or block, leave, remove, Captains (grant, revoke, last-Captain guard, auto-promotion), 16-member limit, share settings, the Manage page, Settings → Privacy overview, Teams in the nav (six items), pinning (`team_members.pinned`), name capture and onboarding changes (§5.8). The Teams tab shows Teams and members only (no class data). **Progress 2026-11-04 (branch `teams`), server side only:** schema (`teams`, `team_members`, `team_join_requests`, random text ids), `server/teams.js` (sole table owner), `server/team-sharing.js` (D3 defaults; missing key = private), `server/teams-routes.js` (all §7.4 routes, invite limiters per IP and per account), `GET /t/:token` generic shell with `Referrer-Policy: no-referrer`, invite tokens scrubbed from request logs, audit rows (create, delete, Captain grant/revoke/auto-promote, removal, block), last-Captain auto-promotion on leave and on account deletion (self and admin), admin Team count per user, own share settings in config export/import. Suite `test-team-membership.js` green. Deviations: a join request also stores the requester's `share_json` (consent, applied on approval); a request that sends a partial share gets private for omitted keys, while sending none gets the D3 defaults; the raw invite token is returned on create and rotate, and Captains can re-copy the current link via `GET /api/teams/:id/invite` (encrypted copy, review fix). **Part B (names, onboarding, landing), 2026-11-04:** account `lastName` (account-scoped, beside `firstName`), both validated by the new `server/user-text.js` (no `<` `>`, control, bidi or zero-width characters, 40-character cap; config import drops invalid names); `/api/my-gyms` rows carry the gym profile's `first_name`/`last_name`, and `name-capture.js inferNames` prefills both (conflicting first names suggest nothing, conflicting last names keep the first name only); one onboarding name screen with both fields (10a) and a Your name card in Settings → Account; Teams clash labels use the initial of the saved last name, fall back to the gym profile only when it was never captured, and show none when it was saved empty. Onboarding: Teams in the welcome feature list (10b), a Teams card with **Create or join a Team** on Make it yours, which finishes onboarding on `/teams` (10c); the Auto-Upgrade tickbox becomes the "already on … change it in Settings" note when at least one linked gym has `autoUpgradeEnabled: true` saved (an unset value is the default, not a set-up, so it keeps the tickbox). Landing: hero paragraph, a Teams nav link and the Teams section (11), mascot at `landing/dibs/pose-skip.webp`. Suites: `test-person-names.js`, vitest in `name-capture.test.js` and `onboarding-routing.test.js`; browser evidence `teams-mockups/screens/t1b-*.png`. **Not yet done:** all client UI (Manage page, Privacy overview, nav, `/t/` client routing) waiting on T-0 mock-ups; the two-account browser run and the 320/375 px nav check; the "Ana is now a Captain" Team-visible notice (needs an activity feed). | `test-team-membership.js` (Captain rules, last-Captain guard, full Team, cooldowns, token rotation, 404-not-403, opaque refs), a browser run of the two-account join flow, and a bottom-nav check at 320 px and 375 px |
| **T-2** (Built, not deployed) | Projection and Teams list | Requires T-B. `team-projection.js`, the 2 h cadence for shared members, `GET /api/teams` today summaries, mascot state machine (pure, unit tested), Teams list cards. **Progress 2026-11-05 (branch `teams`):** `server/team-projection.js` (pure, §7.3), `server/team-data.js` (stored rows only), `server/team-mascot.js` (the one mascot source: states, daily pose registry with bike/boxing eligibility, ring; served to the client as `{state, pose, asset, ring, fit}` because only the server knows other-gym times), `GET /api/teams` today summaries (pinned, then soonest shared class), `GET /api/teams/:id/today` for T-3, `booking_cache.origin` (client-pushed-only rows never projected; a client merge keeps the server's fields), started server rows retained 24 h so done classes count, T-B 2 h predicate = `teams.priorityMemberIds()`. No projection cache, so book/cancel needs no invalidation. Mascot rings and today/hottest lines on the list (`client/src/ui/teams-today.js`). Mascot assets regenerated from `characters/*_alpha.png` (192 px WebP, 6-12 KB). Suites `test-team-privacy.js` (33 checks, mutation-tested), `test-team-projection.js` (11), vitest `teams-today.test.js`; browser evidence `teams-mockups/screens/t2-*.png`. | **`test-team-privacy.js`**: a multi-user, multi-gym matrix in which every share toggle, pause, unlinked gym, disabled gym, cancelled booking and removed member is asserted absent from the payload (the Teams counterpart of `test-gym-isolation.js`) |
| **T-3** (Built, not deployed) | Team dashboard | Header (Share and Manage), Today’s workouts, This week, Classes together with booking CTAs via existing flows, Week view, Members. **Progress 2026-11-06 (branch `teams`):** the dashboard renders from the one projection call (`GET /api/teams/:id/today`). Widgets live in `client/src/ui/teams-dashboard.js` and the pure models in `teams-dashboard-model.js`; each widget renders inside its own guard. Header: mascot with its ring, "Ana and Sam are in class now" and "1 of 4 workouts done today"; Captains see a pending-request count on Manage. **Today's workouts:** done, in-class (a ring to the class end, minutes left) and upcoming rows; hidden when there is nothing today. **This week:** seven day pills with member-coloured dots and no dot text. It opens on the day with the next class and shows at most 3 rows, then See more. Each row is time and name, then instructor · avatars · attendees, with no other-gyms text or space. **Classes together:** the Home favourite card (`renderHomeFavouriteCard` gained `options.extra/status`), with avatars left of the CTA. The CTA is You're in ✓ / Turn on *Gym* / the timetable's own `primaryActionForEvent` (Book, Join waitlist, Auto-book) / Open timetable when the class is not loaded. **Members:** 4 per page with dots, the name/activity/shuffle sort, initials, counts, in class now or next class (with spot when shared), stale "Updated 3 h ago", gym chips, an Other gym pill, and a tap to a Team-scoped profile page (`openTeamsPage`, modal-nav). **Server:** members gained `gyms` (shared ∩ enabled ∩ viewer-linked; empty when paused or sharing nothing) and `otherGym` (a bare flag; an unlinked gym is never named), and `pendingRequestCount` is sent to Captains only. **Tests:** `test-team-privacy.js` +4 checks (37; the chip filter was mutation-tested); vitest `teams-dashboard-model.test.js` (16) and `teams-dashboard.test.js` (5: escaping, row order, See more, CTA routing, profile page). **Browser run 2026-11-06:** the owner's Chrome over CDP, using the dev app on the Tailscale IP and only the mock gyms (Psycle, JAB and AARMY linked). Six seeded teammates and one pending request. Screens `teams-mockups/screens/t3-dashboard-{390,desktop}-{light,dark}.png` and `t3-members-sort-390-light.png`; no console errors. **Not covered in the browser:** the done row state (the clock was just after midnight; covered by vitest only), and clicking a Book CTA (that runs the existing quick-book flow). The one-viewer-without-JAB view is covered by the server matrix, not the browser. | Browser run with three dev accounts across both mock gyms (Psycle and JAB), mobile and desktop, light and dark |
| **T-4** (Built, not deployed; competition not built) | Stats | Counts, Team streak, gym mix, busiest days and times, stats carousel. Opt-in friendly competition and leaderboard (proposed). **Progress 2026-11-06 (branch `teams`):** `server/team-stats.js` (pure) aggregates entries the projection has already filtered by the §7.3 rules (no client-only rows, no unconfirmed `missing_since` rows, no penalised statuses, no paused members, share.gyms and enabled links only). The result is `stats` on `GET /api/teams/:id/today` only; the list payload carries none. Days and hours are read in each class's own zone; the viewer's zone anchors today and the Monday week start. **Share gates:** classes this week counts `activity` sharers at every shared gym, including gyms the viewer hasn't linked (D2, counted, never named). It is compared with last week **up to the same moment**, so a Monday morning doesn't read as a fall. The Team streak needs `activity` **and** `recent` (it is day-level history), counts unlinked gyms (D2), allows today to be still to come, and reads "30+ days" at the 30-day loaded window. The charts (busiest days, gym mix, busiest times; last 4 weeks) count only `recent` sharers at gyms **the viewer has linked**, so they never show more than the itemised Recent list. That rules out small-Team subtraction attacks, and an unlinked gym never appears in or moves the gym mix. **Deviation from mock-up 03e:** no "Other gyms" bar (the brief forbids unlinked gyms altering the mix); the note says "Only gyms you've linked are shown". **UI:** `renderTeamStats` in `teams-dashboard.js` and pure models in `teams-stats-model.js`: two tiles, then the carousel in the order busiest days, gym mix (bars in each gym's `gymBrand` plate colour, with a hairline for dark mode), busiest times (06:00–21:00, widened to data). Mobile swipes with scroll-snap and dots; at ≥900 px the charts sit side by side with no swiping. **Mascot ring (§5.4):** T-2 already took the ring over all the Team's classes today, other gyms included. T-4 finishes it: a class in progress now counts its elapsed share, so the ring moves during class. **Tests:** `test-team-stats.js` (8: class-zone week boundaries across London/New York/Tokyo, the same-moment comparison, streak edges, cap, chart gates); `test-team-privacy.js` +10 (47; client-only, `missing_since`, late-cancel, paused, activity-off and recent-off rows each move an exact number if leaked; unlinked gym id and name absent; a two-member Team whose other member hides history; 404 for non-members; no identity in `stats`; mutation-tested against the four gates); vitest `teams-stats-model.test.js` (8, incl. a viewer-zone day boundary via `lib.js dayKeyInZone`) and 2 render tests (escaping, order, empty state). **Browser run 2026-11-06:** the owner's Chrome over CDP, using the dev app on the Tailscale IP and only the mock gyms. Screens `t4-stats-390-{light,dark}`, `t4-stats-390-light-gym-mix`, `t4-stats-390-light-busiest-times`, `t4-stats-390-dark-gym-mix`, `t4-stats-desktop-{light,dark}`, `t4-hero-ring-390-light`; no console errors, no horizontal overflow at 390 px. **Not built:** friendly competition, leaderboard and personal streaks, and any spot-number change (§8.1). | Unit tests on aggregation, using the zones of the class's gym |
| **T-5** (Not started) | Reach | Timetable Team chips with the overlapping teammate-avatar stack inside (filter-rail stack pattern, §5.3), Home "Your Teams today" widget, the three pushes (with per-Team toggles). | Push dedupe keys in `sent_notifications`. A browser check of the timetable with avatars at 375 px |
| **T-6** (Not started) | Later | Profile photos (§5.5), Book next to, Moments, per-Team nicknames. | Separate specs |

T-1 and T-2 are the privacy-critical core; they should be reviewed (`/code-review high`) before T-3 builds UI on them.

### 8.1 T-4 proposal for the owner: friendly competition and spot numbers (not built)

D13 still marks both as *proposed, owner to confirm*, so T-4 built neither. This section is the decision note. The data model already reserves the switches (`teams.competition_enabled`, `team_members.competition_opt_in`, share key `competition`, default off); nothing reads them yet.

**Friendly competition: the options**

| Option | What the Team sees | New consent needed |
|---|---|---|
| A. Nothing more | Team stats only (T-4 as built) | None |
| B. Team goal (cooperative) | "14 of 20 this week" against a target a Captain sets; no ranking, no names | None: it is the same activity-count total as "classes this week" |
| C. Opt-in leaderboard (the round-2 mock-up, 03g/03j) | Opted-in members ranked by classes this week, with this month alongside; personal streak chips on their member cards (03h) | Captain turns it on for the Team, then each member opts in (both default off) |
| D. Personal bests, private | Your own streak and best week, visible to you only | None |

**Privacy analysis**
- *Counts in a ranking* (option C) reveal nothing new: a member who shares Activity counts already shows "4 this week · 11 in Nov" on their card. What changes is the social pressure of an order. That is why opting in has to be explicit, and why a member who has not opted in must never appear in a ranking, even as "and 3 others".
- *Personal streaks* (C) are day-level, per person. That is more than Activity counts promise ("this week and this month"). It matches what Recent classes shows only for gyms the viewer has linked. At a gym the viewer hasn't linked, a personal streak shows that this one person trained on each of those days. The Team streak (T-4) already counts those days, but anonymously, across the whole Team. So a personal streak must require Activity counts **and** Recent classes **and** the competition opt-in, and the opt-in copy must say "Teammates see your streak, including days at gyms they don't use".
- *Exclusion by omission:* a member's absence from the leaderboard reveals only that they have not opted in, which the member list implies anyway. Late cancels and no-shows are never counted (as everywhere in Teams), so a rank can't drop in a way that hints at one.
- *Small Teams:* in a Team of two, a ranking is just the other person's count, which their card already shows. No extra suppression is needed if the rule above holds (only opted-in members, only shared counts).
- *Wellbeing:* rankings reward volume. Option B rewards the group, and ranks nobody.

**Recommendation:** build **B (Team goal)** first. It needs no new consent and fits "train with your people". Add **C** only if the owner wants rankings, gated exactly as above, with week counts ranked and ties sharing a place.

**Spot numbers (the earlier open question).** Sharing is opt-in (`share.spots`, default off), and T-3 already shows a shared spot ("Ana · Bike 14") in attendee rows and on member cards. So part (a) of §5.3 shipped ahead of D13's confirmation. Options:
- (i) Keep it as built.
- (ii) Show a teammate's spot only to viewers booked into, waitlisted for or queued for the **same class**. That is the only case where "pick the bike next to Ana" is actionable, and it stops a spot reaching teammates who aren't going.
- (iii) Remove spot display until the owner confirms.

The privacy step from (i) to (ii) is real: a spot pins a person to a seat at a known time and place (principle 7). (b), the spot-picker "teammate seats" (T-6 Book next to), is only meaningful under (ii) anyway.

**Recommendation:** (ii). It is a small projection change: attach `spot` only when the viewer is an attendee of that class key. Confirm (b) for T-6 on the same rule.

## 9. Decisions (settled by the user, 2026-11-04)

| ID | Question | Decision |
|---|---|---|
| D1 | Navigation | Home · Timetable · Bookings · Auto-Book · Teams · Settings. Credits is hidden for all users and not expected back. |
| D2 | Classes at gyms the viewer hasn't linked | Details hidden; counted as "+N at other gyms" in the mascot and totals |
| D3 | Sharing defaults | Everything on except **spot numbers** and the **auto-book queue**, which are opt-in |
| D4 | Roles and approval | **Captains** with equal, shared ownership. **Only Captains approve** requests (no "any member can approve" setting; removed 2026-11-04). The Manage page (§5.7) covers members' own sharing and leaving, and Captains' member and Captain management. |
| D8 | Teams list (2026-11-04) | No pending-request badge. Members of more than 3 Teams can pin up to 2. "Rest day", not "Quiet day". |
| D9 | Joining (2026-11-04) | Strictly via URL. The Teams list's "Join with a link" paste field is removed (that was the "invite link widget"); the empty state offers Create only. Pending requests are visible only on the invite link page itself. Captains keep link management: Share in the dashboard header, Reset link and Turn off joining in Team settings. |
| D10 | Dashboard (2026-11-04) | Today's workouts first, then This week. Stats are a carousel on mobile. Team streak defined in §5.3. |
| D11 | Mascot poses (2026-11-04) | The exercising pose rotates daily from a registry in one module (§5.4). |
| D12 | Names (2026-11-04) | Collect first and last name; Teams show first name plus last initial on a clash (§5.5, §5.8). |
| D13 | Proposed, owner to confirm after mock-up round 2 | Friendly competition (§5.3) and spot-number display (§5.3). |
| — | Background sync | Every account's classes are refreshed in the background regardless of app use (§7.2, T-B) |
