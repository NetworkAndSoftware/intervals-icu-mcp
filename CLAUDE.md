# intervals.icu MCP Server

## Project Overview

An MCP (Model Context Protocol) server that exposes intervals.icu cycling/rowing data as tools Claude can call. Runs locally via stdio transport for use with Claude Code and Claude Desktop.

The user is an active road cyclist who tracks with a Garmin Edge 840 and Wahoo TICKR chest strap, syncing to Garmin Connect and then to intervals.icu. They also row (EXR/concept2). They race USAC-permitted events and care about power data, training load (CTL/ATL/TSB), and performance trends.

## Tech Stack

- **Runtime:** Node.js (TypeScript)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Cache:** SQLite via `better-sqlite3`
- **HTTP client:** `fetch` (native in Node 18+)
- **Transport:** stdio
- **Build:** `npx tsc` → outputs to `dist/`

## Authentication

intervals.icu uses HTTP Basic auth:
- **Username:** `API_KEY` (literal string, not the athlete ID)
- **Password:** the API key from intervals.icu Settings → Developer Settings
- **Athlete ID:** used in URL path, not in auth header

Credentials stored in `.env` (gitignored):
```
INTERVALS_ATHLETE_ID=i12345
INTERVALS_API_KEY=your_api_key_here
```

Base URL: `https://intervals.icu/api/v1/athlete/{ATHLETE_ID}/`

## Implemented Tools

### Read Tools

| Tool | Description | Cache TTL |
|------|-------------|-----------|
| `get_activities` | List activities in date range. Supports `type` filter and `query` (string or `/regex/`) | 1 hour |
| `get_activity` | Full detail for a single activity | Never expires |
| `get_activity_streams` | Time-series data (watts, HR, cadence, etc.) | Never expires |
| `get_fitness` | Weekly fitness summaries (CTL/ATL/TSB, ramp rate, zone times, by-category breakdowns) | 4 hours |
| `get_events` | Calendar events (planned workouts, targets, notes) | 1 hour |
| `get_power_curve` | Best power for each duration over a date range | 4 hours |
| `get_wellness` | Daily wellness (weight, resting HR, HRV, sleep, mood, etc.) | 1 hour (today), never (past) |
| `get_athlete_zones` | Power and HR zone definitions | 24 hours |
| `get_coaching_context` | Compact aggregated snapshot for LLM coaching — current fitness, planned vs actual, wellness trends, activity summaries, optional season progression | 1–4 hours |

### Write Tools

| Tool | Description |
|------|-------------|
| `create_event` | Create a workout, target, note, race, or rest day on the calendar |
| `update_event` | Update fields on an existing event |
| `delete_event` | Delete a planned workout or event by event ID |
| `set_weekly_target` | Set/update weekly load/duration/distance target (creates or updates TARGET event) |
| `upload_activity` | Upload a completed activity file (.fit/.gpx/.tcx) |
| `delete_activity` | Delete an activity by activity ID |

### Utility Tools

| Tool | Description |
|------|-------------|
| `clear_cache` | Clear the SQLite cache so fresh data is fetched |

## Known Issues & Gotchas

### Strava-locked activities
Activities sourced from Strava (`source: "STRAVA"`) return no name, type, TSS, or any useful data via the API. This is a Strava API licensing restriction. The `get_fitness` endpoint includes their load in aggregates, but individual activity detail is inaccessible. Workaround: delete and re-upload the `.fit` file directly so it comes in as `FILE_UPLOAD`.

### API field name mismatches for events
The intervals.icu UI reads different fields than what the API names suggest for planned workout targets:

| Concept | API accepts | UI displays |
|---------|-------------|-------------|
| Planned load (TSS) | `load_target` | `icu_training_load` |
| Planned duration | `time_target` | `moving_time` |
| Planned distance | `distance_target` | `distance` |

The `create_event` and `update_event` tools set both fields automatically.

### Fitness API field names
The fitness/athlete-summary endpoint uses:
- `fitness` (not `ctl`), `fatigue` (not `atl`), `form` (not `tsb`)
- `rampRate` (camelCase)
- `date` (not `start_date_local`)
- `eftp` is per-sport inside `byCategory[].eftp`, keyed by `byCategory[].category`
- `timeInZones` is an array of seconds: `[Z1, Z2, Z3, Z4, Z5, Z6, Z7, SS]`
- API returns entries newest-first

## Project Structure

```
intervals-icu-mcp/
├── CLAUDE.md              # This file
├── .env                   # Credentials (gitignored)
├── .gitignore
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts           # Entry point, MCP server setup, clear_cache tool
│   ├── api.ts             # intervals.icu API client (all HTTP methods)
│   ├── cache.ts           # SQLite cache layer
│   ├── types.ts           # TypeScript interfaces (StreamType)
│   └── tools/
│       ├── activities.ts  # get_activities, get_activity, get_activity_streams
│       ├── fitness.ts     # get_fitness, get_events
│       ├── power-curve.ts # get_power_curve
│       ├── wellness.ts    # get_wellness
│       ├── zones.ts       # get_athlete_zones
│       ├── upload.ts      # create_event, update_event, delete_event, delete_activity,
│       │                  # upload_activity, set_weekly_target
│       └── coaching.ts    # get_coaching_context (aggregated coaching snapshot)
├── dist/                  # Compiled JS (gitignored)
└── cache.db               # SQLite database (gitignored)
```

## Caching

SQLite database (`cache.db`) with schema:
```sql
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl INTEGER NOT NULL
);
```

Use `clear_cache` tool to flush when data seems stale.

## MCP Server Registration

In Claude Desktop or Claude Code settings:
```json
{
  "mcpServers": {
    "intervals-icu": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "C:/Users/jmvw/Proton Drive/fisaga/My files/src/intervals-icu-mcp"
    }
  }
}
```

Claude Desktop must be restarted to pick up new/changed tool schemas.

## API Reference

Docs: https://intervals.icu/api-docs.html

Key endpoints used:
- `GET /api/v1/athlete/{id}/activities` — list activities
- `GET /api/v1/athlete/{id}/activities/{activityId}` — activity detail
- `GET /api/v1/athlete/{id}/activities/{activityId}/streams` — streams
- `GET /api/v1/athlete/{id}/athlete-summary` — weekly fitness aggregates
- `GET /api/v1/athlete/{id}/events` — calendar events
- `GET /api/v1/athlete/{id}/power-curve` — power curve
- `GET /api/v1/athlete/{id}/wellness` — wellness
- `GET /api/v1/athlete/{id}/zones` — zones
- `POST /api/v1/athlete/{id}/activities` — upload activity (multipart)
- `POST /api/v1/athlete/{id}/events` — create event
- `PUT /api/v1/athlete/{id}/events/{eventId}` — update event
- `DELETE /api/v1/athlete/{id}/events/{eventId}` — delete event
- `DELETE /api/v1/athlete/{id}/activities/{activityId}` — delete activity

## Development Notes

- Build with `npx tsc`. No test framework yet.
- The server is spawned fresh per tool call (stdio transport) — no persistent process.
- Error handling maps HTTP status codes to meaningful messages (401 → auth failure, 404 → not found, 429 → rate limited).
- Activities from Strava are effectively opaque — plan around this limitation.
