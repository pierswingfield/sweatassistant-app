# Backlog Spec: Sweat Assistant — Multi-Provider Modular Gym Architecture

> **⚠️ Superseded.** This high-level spec is kept for reference. The authoritative, detailed plan (with rigorous analysis, phased work packages, testing, and the multi-agent handoff protocol) now lives in **[modular-gyms/](./modular-gyms/)** — start with [PLAN.md](./modular-gyms/PLAN.md). Locked decisions since this spec was written: **multiple gyms per account** (not the single `users.gym_id` column shown below), **"Sweat Assistant"** umbrella brand, and **full parity minus purchases** for the JAB v1.

## Context & Vision
The current application is hardcoded to Psycle London (which uses the CodexFit scheduling platform). The goal is to evolve the platform into **Sweat Assistant**—a modular, multi-gym, multi-provider booking and scheduling assistant. 

This requires support for both:
1. **CodexFit** (e.g., Psycle London)
2. **Mariana Tek** (e.g., JAB Boxing Club, Barry's Boot Camp)

We must separate the core application core (scheduler, cron poller, PWA shell, notifications fan-out) from the provider-specific API logic (auth, schedules, bookings, layout parsing, and spots).

---

## 1. Provider Adapter Interface (Abstraction)
We will introduce a `GymProvider` abstract interface (or class wrapper) that every gym service adapter must implement.

```typescript
interface GymProvider {
  // Authentication
  login(credentials: UserCredentials): Promise<AuthProviderSession>;
  validateSession(session: AuthProviderSession): Promise<boolean>;
  refreshSession(session: AuthProviderSession, credentials: UserCredentials): Promise<AuthProviderSession>;
  
  // Timetable & Metadata
  fetchTimetable(params: TimetableQueryParams): Promise<NormalizedEvent[]>;
  fetchEventDetails(eventId: string, session?: AuthProviderSession): Promise<NormalizedEventDetails>;
  
  // Bookings & Waitlists
  bookSlot(eventId: string, slotIds: string[], session: AuthProviderSession): Promise<BookingResult>;
  cancelBooking(bookingId: string, session: AuthProviderSession): Promise<boolean>;
  joinWaitlist(eventId: string, session: AuthProviderSession): Promise<boolean>;
  leaveWaitlist(eventId: string, session: AuthProviderSession): Promise<boolean>;
  
  // Auto-Upgrade / Spot Swapping
  swapSpots?(bookingId: string, currentSlotId: string, targetSlotId: string, session: AuthProviderSession): Promise<boolean>;
}
```

### Key Differences to Arbitrate:
- **Spot Swapping**: Mariana Tek supports native spot swapping (`POST /me/reservations/{id}/swap_spots`). CodexFit does not, requiring a cancel-then-rebook fallback wrapper.
- **Booking Windows**: CodexFit uses standard cutoffs (`booking_cutoff` date fields on profile). Mariana Tek publishes a specific `booking_start_datetime` per class session. The adapter must normalize this to a unified `nextReleaseAt` date.

---

## 2. Database Schema Upgrades (SQLite/PostgreSQL)

To support multiple gyms and providers, we must update the database schema.

```sql
-- 1. Gym Configuration Table
CREATE TABLE gyms (
  id TEXT PRIMARY KEY,               -- e.g. "psycle-london", "jab-boxing"
  name TEXT NOT NULL,                -- e.g. "Psycle London"
  provider TEXT NOT NULL,            -- "codexfit" | "marianatek"
  base_url TEXT NOT NULL,            -- e.g. "https://psycle.codexfit.com"
  public_host TEXT NOT NULL,         -- e.g. "psyclelondon.com"
  config_json TEXT NOT NULL          -- Extra provider config (client_ids, headers, VAPID, etc.)
);

-- 2. Modify Users Table
-- Users are now linked to a specific gym.
ALTER TABLE users ADD COLUMN gym_id TEXT REFERENCES gyms(id);

-- 3. Modify Bookings & Monitors
-- Track which gym a queue entry belongs to.
ALTER TABLE auto_bookings ADD COLUMN gym_id TEXT REFERENCES gyms(id);
ALTER TABLE auto_upgrades ADD COLUMN gym_id TEXT REFERENCES gyms(id);
```

---

## 3. PWA Frontend Upgrades

1. **Gym Selector / Multi-tenant Entry**:
   - On boarding/login, the user selects their gym (e.g. "Psycle", "JAB Boxing").
   - The theme dynamically changes based on the selected gym's colors (Psycle's violet vs JAB's dark navy).
2. **Normalized Floor Plans**:
   - The interactive floor plan components (`client/src/ui/spotmap.js` and `timetable.js`) must parse both CodexFit layouts (x/y coordinates in rows/columns) and Mariana Tek layouts (coordinate-based Pick-A-Spot format).
3. **Gym Context Headers**:
   - Client requests to the BFF must include `x-gym-id` so the server proxy maps the request to the correct provider credentials.
