# Backlog Spec: Username-Based Social Class Sharing

**Status**: ❌ Open (Backlog Spec)  
**Parent**: [BACKLOG.md](../BACKLOG.md) → "Username-Based Social Class Sharing"

---

## 1. The Ask & Goals

Stakeholder feature request (2026-09-15):
> *"Username-based social sharing of classes. Be able to see from the web ui (or optionally your calendar) who is attending which classes."*

### Primary Objectives
1. **Sweat Assistant Handles (`@username`)**: Allow users to configure a unique username and display name distinct from gym login emails.
2. **Social Graph**: Mutual connection / friend model (search by handle, send request, accept/reject, block).
3. **Web UI Attendance Indicators**:
   - **Timetable Grid & Mobile Cards**: Visual indicator (e.g. `👥 2 friends` or mini-avatars) showing which friends are booked into scheduled classes.
   - **Filter by Friends**: Filter timetable to classes where at least one friend is attending.
   - **Spot Map Highlighting**: When viewing studio layouts (Psycle Ride, JAB Train/Boxing), highlight the spots friends have reserved (if permitted by privacy settings).
4. **Calendar (.ics) Integration**:
   - **Enriched Feed**: Optionally include attending friends' names/handles in the `DESCRIPTION` of existing iCalendar event sync (`/api/calendar/:token.ics`).
   - **Companion Friends Feed**: Optional secondary `.ics` subscription URL displaying classes friends are attending as a separate calendar layer in Apple/Google Calendar.

---

## 2. Privacy & Permission Model

Fitness studio attendance reveals real-world location, daily routines, and personal habits. Privacy must be opt-in and granular:

| Setting | Options | Default | Description |
|---|---|---|---|
| `profile_visibility` | `friends_only`, `private` | `friends_only` | Who can find the user via username search. |
| `share_class_attendance` | `friends_only`, `nobody` | `friends_only` | Whether mutual friends see classes the user books. |
| `share_spot_number` | `true`, `false` | `true` | Whether friends see exact spot number (e.g. Bike 14) or just class presence. |
| `calendar_social_enrichment` | `true`, `false` | `false` | Include attending friends' names in the personal `.ics` feed descriptions. |
| `calendar_friends_feed_enabled` | `true`, `false` | `false` | Expose dedicated subscription URL for friends' workouts. |
| Per-Booking Privacy Toggle | `private_booking: boolean` | `false` | User can flag any specific booking as private (hidden from friends regardless of global settings). |

> [!IMPORTANT]
> **Mutual Consent Required**: Friendships must be bi-directional (both users agree). One-way following without consent is not permitted to prevent unreciprocated tracking.

---

## 3. UI/UX Concept & Visual Mockups

### Timetable Desktop Row
```
TIME    GYM     CLASS     INSTRUCTOR   STUDIO             FRIENDS          STATUS     ACTIONS
07:30   Psycle  Ride 45   Emma         Ride Studio 1      👥 @sarah, @alex  12 spots   [ Book  ▾ ]
```

### Mobile Timetable Card
```
┌─────────────────────────────────────────────────────────────┐
│ 07:30 · Psycle · RIDE 45                    Emma            │
│ Ride Studio 1 — Oxford Circus               12 spots left   │
│ 👥 Sarah (@sarah) and Alex (@alex) attending                │
│ ─────────────────────────────────────────────────────────── │
│ [ Quick Book ]                                  [ ⚙ ]       │
└─────────────────────────────────────────────────────────────┘
```

### Studio Spot Map (Psycle Ride / JAB Train)
```
┌─ Studio Layout ─────────────────────────────────────────────┐
│                      [ INSTRUCTOR ]                         │
│                                                             │
│   [ 1 ]       [ 2 ]       [ 3 ]       [ 4 (👥 Sarah) ]       │
│                                                             │
│   [ 5 ]       [ 6 ]       [ 7 (👥 Alex) ]  [ 8 ]            │
└─────────────────────────────────────────────────────────────┘
```

### Calendar (`.ics`) Event Description
```text
BEGIN:VEVENT
SUMMARY:Psycle Ride 45 (Emma)
LOCATION:Psycle Oxford Circus - Ride Studio 1
DESCRIPTION:Class: Ride 45\nInstructor: Emma\nStudio: Ride Studio 1\n\nAttending Friends: Sarah W (@sarah - Bike 4), Alex T (@alex - Bike 7)
...
END:VEVENT
```

---

## 4. Architecture & Data Model

### Database Schema (SQLite)

```sql
-- Add username and profile fields to users
ALTER TABLE users ADD COLUMN username TEXT UNIQUE;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url TEXT;

-- Social connection graph (mutual relationships)
CREATE TABLE social_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'blocked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, friend_id)
);

-- User social & calendar privacy preferences
CREATE TABLE user_social_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  share_attendance TEXT NOT NULL DEFAULT 'friends_only' CHECK(share_attendance IN ('friends_only', 'nobody')),
  share_spot_number INTEGER NOT NULL DEFAULT 1,
  calendar_enrichment INTEGER NOT NULL DEFAULT 0,
  friends_feed_token TEXT UNIQUE,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Internal attendance cache: populated by poller and booking sync
-- Normalizes who is booked where without making real-time cross-user provider calls
CREATE TABLE class_attendances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gym_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_label TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(gym_id, event_id, user_id)
);

CREATE INDEX idx_class_attendances_lookup ON class_attendances(gym_id, event_id);
CREATE INDEX idx_social_connections_users ON social_connections(user_id, status);
```

### API Surface

1. **User Profile & Search**:
   - `GET /api/social/profile` — Get current user's handle, display name, and social settings.
   - `POST /api/social/profile` — Set or update username and display name.
   - `GET /api/social/search?q=...` — Search available users by handle.
2. **Friends Management**:
   - `GET /api/social/friends` — List friends, pending incoming/outgoing requests.
   - `POST /api/social/friends/request` — Send friend request by username.
   - `POST /api/social/friends/:id/accept` — Accept incoming request.
   - `POST /api/social/friends/:id/reject` — Decline request.
   - `DELETE /api/social/friends/:id` — Remove friend or cancel request.
3. **Attendance Query (Fast Batch Lookup)**:
   - `GET /api/social/attendance?start=YYYY-MM-DD&end=YYYY-MM-DD` — Returns map of `eventId -> [{ username, displayName, spotLabel }]` for mutual friends across linked gyms.
4. **Calendar Export**:
   - `GET /api/calendar/:token.ics` — Enriches event `DESCRIPTION` if `calendar_enrichment == 1`.
   - `GET /api/calendar/friends/:friendsFeedToken.ics` — Dedicated feed of friends' scheduled workouts.

---

## 5. Implementation Phases

- **Phase 1: Identity & Relationships (Backend & DB)**
  - Schema migration for usernames, social connections, and privacy preferences.
  - CRUD endpoints for friend requests and profile setup.
  - Automated tests (`test-social-graph.js`).
- **Phase 2: Attendance Indexing**
  - Store booking synchronizations into `class_attendances` when users book or poller updates active bookings.
  - Clean up attendances on class cancellations or completions.
  - Build `GET /api/social/attendance` with efficient SQL join on mutual friends.
- **Phase 3: Web UI Integration**
  - Settings UI: Handle setup, friend management drawer/modal, privacy checkboxes.
  - Timetable integration: Add friends badge/avatars to desktop rows and mobile cards.
  - Timetable filter: Add "With Friends" toggle in filter bar.
  - Spot Map integration: Render friend indicator tags on reserved spots.
- **Phase 4: Calendar (.ics) Enhancement**
  - Update `server/calendar.js` to optionally append friend rosters to event descriptions.
  - Add optional dedicated friends `.ics` feed endpoint and subscription button in Settings.
