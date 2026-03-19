# intervals-icu-mcp

An MCP (Model Context Protocol) server that connects Claude to your [intervals.icu](https://intervals.icu) training data. Query activities, fitness trends, wellness metrics, and manage your training calendar through natural conversation.

## What it does

This server exposes your intervals.icu data as tools that Claude can call, enabling conversations like:

- "What was my TSS last week?"
- "How has my CTL trended this season?"
- "Add a Z2 ride for Thursday with 100 TSS planned"
- "Compare my planned vs actual load for the past 4 weeks"

## Tools

### Read
| Tool | Description |
|------|-------------|
| `get_activities` | List activities with optional type filter and name search (string or regex) |
| `get_activity` | Full detail for a single activity |
| `get_activity_streams` | Time-series data (power, HR, cadence, GPS, altitude) |
| `get_fitness` | Weekly fitness summaries (CTL/ATL/TSB, ramp rate, zone times, by-sport breakdowns) |
| `get_events` | Calendar events (planned workouts, weekly targets, notes) |
| `get_power_curve` | Best power for each duration over a date range |
| `get_wellness` | Daily wellness (weight, resting HR, HRV, sleep, mood, etc.) |
| `get_athlete_zones` | Power and HR zone definitions |
| `get_coaching_context` | Compact aggregated snapshot for coaching — fitness, planned vs actual, wellness, activities, optional season progression |

### Write
| Tool | Description |
|------|-------------|
| `create_event` | Create a workout, target, note, race, or rest day |
| `update_event` | Update fields on an existing event |
| `delete_event` | Delete an event by ID |
| `set_weekly_target` | Set/update weekly load, duration, or distance target |
| `upload_activity` | Upload a .fit/.gpx/.tcx file |
| `delete_activity` | Delete an activity by ID |

### Utility
| Tool | Description |
|------|-------------|
| `clear_cache` | Flush the local SQLite cache |

## Setup

### Prerequisites

- Node.js 18+
- An [intervals.icu](https://intervals.icu) account with API access

### 1. Clone and install

```bash
git clone https://github.com/NetworkAndSoftware/intervals-icu-mcp.git
cd intervals-icu-mcp
npm install
```

### 2. Configure credentials

Copy `.env.example` to `.env` and fill in your details:

```
INTERVALS_ATHLETE_ID=i12345
INTERVALS_API_KEY=your_api_key_here
```

Get your API key from intervals.icu **Settings > Developer Settings**.

### 3. Build

```bash
npm run build
```

### 4. Register with Claude

**Claude Desktop** — add to your MCP settings (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "intervals-icu": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/intervals-icu-mcp"
    }
  }
}
```

**Claude Code** — add via CLI:

```bash
claude mcp add intervals-icu -- node /path/to/intervals-icu-mcp/dist/index.js
```

Restart Claude Desktop after adding or updating the server.

## Caching

Responses are cached in a local SQLite database (`cache.db`) to minimize API calls:

| Data | TTL |
|------|-----|
| Activity detail & streams | Never expires |
| Activity list, events | 1 hour |
| Fitness summaries | 4 hours |
| Wellness (past days) | Never expires |
| Wellness (today) | 1 hour |
| Zones | 24 hours |

Use the `clear_cache` tool to force fresh data.

## Known limitations

- **Strava-sourced activities** return no data via the intervals.icu API (Strava licensing restriction). Activities synced from Garmin, Wahoo, or uploaded directly work fine.
- **No field selection** on the activities API — full objects are fetched and cached.

## Tech stack

- TypeScript / Node.js
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for caching
- stdio transport

## License

MIT
