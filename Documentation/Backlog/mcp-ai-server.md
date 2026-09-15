# Backlog Spec: Model Context Protocol (MCP) Server for AI Integration

**Status**: ❌ Open (Backlog Spec)  
**Parent**: [BACKLOG.md](../BACKLOG.md) → "Model Context Protocol (MCP) Server for AI Integration"

---

## 1. The Ask & Vision

Stakeholder feature request (2026-09-15):
> *"mcp server for ai integration"*

Provide an official **Model Context Protocol (MCP)** server for Sweat Assistant. This enables local and remote AI agents (e.g. Claude Desktop, Cursor, Antigravity, custom local/remote LLM workflows) to directly interface with Sweat Assistant to:
- Inquire about upcoming schedules across multiple fitness providers: *"What ride classes does Emma have next Thursday evening at Oxford Circus?"*
- Audit and track balances: *"How many credits do I have left at Psycle and when do they expire?"*
- Manage bookings: *"Book me into the Saturday 10:00 JAB Boxing class on bag 5."*
- Automate future booking: *"Queue an auto-book for next Tuesday's 07:30 Reformer class as soon as the booking window opens."*
- Review auto-book queue and waitlists: *"What classes am I currently queued for?"*

Because Sweat Assistant has already normalized gym providers (`routes-normalized.js`, `providers/base.js`, `gyms.config.js`), the MCP server operates completely gym-agnostically across Psycle, JAB, and future providers.

---

## 2. Transports & Deployment

The server will support two standard MCP transports:

1. **Local CLI (`stdio`)**:
   - Packaged script (e.g. `bin/sweat-mcp.js`).
   - Intended for local desktop clients (Claude Desktop, Cursor, local terminal agents).
   - Configured via client config (e.g. `claude_desktop_config.json`) with an API key or base URL:
     ```json
     {
       "mcpServers": {
         "sweat-assistant": {
           "command": "node",
           "args": ["/path/to/server/mcp-stdio.js"],
           "env": {
             "SWEAT_ASSISTANT_URL": "https://sweat.wingfield.tech",
             "SWEAT_ASSISTANT_API_KEY": "sa_mcp_live_..."
           }
         }
       }
     }
     ```

2. **Remote HTTP / Server-Sent Events (`SSE`)**:
   - Mounted directly on the Express server:
     - `GET /api/mcp/sse` (initiates SSE stream, sends endpoint URI)
     - `POST /api/mcp/messages?sessionId=...` (client message transport)
   - Authenticated via `Bearer sa_mcp_...` Personal Access Token.
   - Allows cloud-hosted or mobile agents to connect directly without local script execution.

---

## 3. Security, Scopes & Safety Controls

Fitness class bookings spend financial credits and auto-book queues trigger high-precision automated execution. Security controls are essential:

### Personal Access Tokens (PAT)
- Generated in the PWA Settings tab under **Account → Developer & AI (MCP)**.
- Stored as hashed tokens (`sha256(token)`) in SQLite `api_tokens` table.
- Granular permissions / scopes:
  - `read:schedule` — Timetables, studios, instructors, layouts.
  - `read:account` — My bookings, waitlists, credit balances, memberships.
  - `read:autobook` — View Auto-Book queue and release countdowns.
  - `write:bookings` — Execute bookings, cancel reservations, swap spots.
  - `write:autobook` — Add or cancel targets in the Auto-Book scheduler.

### Safety Guards for Mutation Tools
- Mutating tools (especially `book_class` which spends credits) return structured dry-run / confirmation warnings if invoked without an explicit `confirm: true` flag.
- Detailed audit logging for all AI-invoked actions with client user-agent / session tracking.

---

## 4. MCP Tools Specification

### Discovery & Read Tools

| Tool | Parameters | Description |
|---|---|---|
| `list_connected_gyms` | *(none)* | Returns linked gyms, membership/credit capabilities, and active status. |
| `get_timetable` | `startDate` (ISO), `endDate` (ISO), `gymId?`, `instructor?`, `discipline?`, `location?` | Search scheduled classes across linked gyms with spot availability. |
| `get_class_details` | `gymId`, `eventId` | Returns full class metadata, instructor bio, booking window cutoff, and spot layout. |
| `get_my_bookings` | `gymId?`, `includeHistory?` | Returns confirmed bookings, waitlists, assigned spot labels, and cancellation cutoffs. |
| `get_credits_and_memberships` | *(none)* | Returns remaining credit count, expiration dates, and membership status per gym. |
| `get_autobook_queue` | *(none)* | Lists all targets queued for precision landrush auto-booking, priority tier, and release timers. |

### Mutation & Action Tools

| Tool | Parameters | Description |
|---|---|---|
| `book_class` | `gymId`, `eventId`, `spotId?`, `confirm` (bool) | Reserve a spot in an open class. Checks credit sufficiency first. |
| `cancel_booking` | `gymId`, `bookingId`, `confirm` (bool) | Cancel an existing reservation within the free cancellation window. |
| `swap_spot` | `gymId`, `bookingId`, `newSpotId` | Atomically swap to a different spot/bike (for gyms supporting atomic swap). |
| `queue_autobook` | `gymId`, `eventId`, `preferredSpots?` (array), `fallbackToAnySpot` (bool) | Queue a class target for automated landrush booking upon window release. |
| `cancel_autobook` | `autoBookId` | Remove a target from the auto-book scheduler queue. |

---

## 5. MCP Resources Specification

Expose standard contextual resources for LLM context hydration:
- `sweat://account/overview` — Current user identity, linked gyms, total available credits.
- `sweat://schedule/upcoming` — Markdown/JSON snapshot of the user's upcoming week of confirmed classes.
- `sweat://autobook/queue` — Current active auto-book targets and countdown times.

---

## 6. Architecture & Implementation Plan

```
server/
├── mcp/
│   ├── index.js          # Core MCP Server factory using @modelcontextprotocol/sdk
│   ├── tools-read.js     # Timetable, bookings, credits, layout tool handlers
│   ├── tools-write.js    # Booking, cancellation, auto-book mutation handlers
│   ├── resources.js      # sweat:// resource handlers
│   └── auth.js           # API token validation & gym context setup
├── routes-mcp.js         # Express SSE routes (/api/mcp/sse, /api/mcp/messages)
└── bin/
    └── mcp-stdio.js      # Executable CLI stdio runner for local clients
```

### Database Schema Addition
```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL, -- e.g. "sa_mcp_a1b2..."
  scopes TEXT NOT NULL,       -- JSON array: ["read:schedule", "read:account", ...]
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_api_tokens_lookup ON api_tokens(token_hash);
```

### Execution Phases
- **Phase 1: Token Management & Schema**
  - Database migration for `api_tokens`.
  - API endpoints for generating, listing, and revoking API keys (`/api/tokens`).
  - Settings UI section to generate MCP tokens with scope selection.
- **Phase 2: Core MCP Server & Read Tools**
  - Integrate `@modelcontextprotocol/sdk`.
  - Implement read tools (`get_timetable`, `get_my_bookings`, `get_credits_and_memberships`, `get_autobook_queue`).
  - Implement stdio transport script (`server/bin/mcp-stdio.js`).
- **Phase 3: Write & Mutation Tools**
  - Implement `book_class`, `cancel_booking`, `swap_spot`, and `queue_autobook` with safety confirmation guards.
  - Add comprehensive regression tests (`server/test-mcp.js`).
- **Phase 4: Remote SSE Transport**
  - Add `/api/mcp/sse` endpoint on Express server with bearer token auth.
  - Test remote agent connections (e.g. Claude Desktop via SSE, remote agents).
