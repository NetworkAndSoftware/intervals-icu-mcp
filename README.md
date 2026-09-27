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
| `upload_activity` | Upload a .fit/.gpx/.tcx file (local server only) |
| `delete_activity` | Delete an activity by ID |

### Utility
| Tool | Description |
|------|-------------|
| `clear_cache` | Flush the cache |

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

## Remote hosting on AWS Lambda (claude.ai web and mobile)

claude.ai custom connectors, which also appear in the Claude mobile app, need a public HTTPS server. The same code can run on AWS Lambda behind a Function URL, shared by several athletes:

- **Login:** each athlete has their own name and password. The first time they connect, Claude opens a sign-in page on the server. claude.ai connectors only support OAuth or no authentication, so a plain API key header isn't an option.
- **Data:** each athlete's tools use their own intervals.icu API key, so they only see their own data. The cache is kept separately per athlete too.
- **Secrets:** the athletes' intervals.icu API keys, their passwords and the token-signing secret are stored as encrypted SSM Parameter Store values. They never appear in the function's configuration or in the repo.
- **Cost:** normally $0, within Lambda's always-free allowance (1M requests and 400,000 GB-seconds a month). Set up an AWS budget alert anyway.

### One-time setup

1. Install the AWS CLI and SAM CLI, then sign in with a default region:
   ```bash
   winget install Amazon.AWSCLI
   winget install Amazon.SAM-CLI
   aws configure        # or: aws login
   ```
2. Add yourself as the first user. This takes your athlete ID and API key from `.env`, checks them with intervals.icu, and prints a generated password. Save it in your password manager.
   ```bash
   npm run users -- add <your-name> --from-env
   ```
3. Build and deploy. Confirm the changeset when asked; the output ends with `McpServerUrl`.
   ```bash
   npm run deploy
   ```
4. In claude.ai, go to **Settings → Connectors → Add custom connector** and paste the `McpServerUrl` exactly (it ends in `/mcp`). Click **Connect**, then sign in with your name and password on the page that opens. The connector then works on web and mobile. Claude renews its access automatically, and you'll only be asked to sign in again after 90 days without use.

### Adding another athlete

1. Ask them for their intervals.icu athlete ID (on the Settings page, like `i12345`) and API key (Settings → Developer Settings). Their API key gives full access to their intervals.icu account, and it'll be stored in your AWS account, so only do this with people who trust you with it.
2. Run the following and enter the athlete ID and API key when prompted. The API key isn't shown as it's typed. The credentials are checked with intervals.icu before they're saved.
   ```bash
   npm run users -- add <their-name>
   ```
3. Send them the printed password privately, together with the `McpServerUrl`. They add the connector in their own claude.ai account (step 4 above) and sign in with their name and password. On the Free plan, claude.ai allows one custom connector.

### Day to day

| Task | Command |
|------|---------|
| Deploy code changes | `npm run deploy` |
| List users | `npm run users -- list` |
| Show someone's password again | `npm run users -- show-password <name>` |
| New intervals.icu API key | `npm run users -- add <name>` (add `--from-env` for your own key from `.env`) |
| New password (signs that user out) | `npm run users -- new-password <name>` |
| Remove a user | `npm run users -- remove <name>` |
| Sign everyone out | `npm run users -- sign-out-all` |
| Remove everything | `sam delete` |

Lambda reads the secrets once per cold start, so every `users` change also replaces the function's running instances. That way a change takes effect immediately.

### Differences from the local server

- `upload_activity` isn't offered, and `create_event` rejects `file_path`. There's no local disk to read from, and reading the server's own files could leak its AWS credentials.
- The cache is held in memory per Lambda instance, so it starts empty after a cold start.
- To test the remote setup locally, set `MCP_PASSWORD` and `MCP_SIGNING_SECRET` in `.env` and run `npm run build && npm run start:http`. The server listens on `http://localhost:3000/mcp`, and you sign in as `me` with the `.env` athlete. Set `MCP_USERS` to the same JSON array Lambda uses to test several users.

## Caching

Responses are cached to minimize API calls: locally in a SQLite database (`cache.db`), and in memory per athlete on the Lambda-hosted server.

| Data | TTL |
|------|-----|
| Activity detail & streams | Never expires |
| Activity list, events | 1 hour |
| Fitness summaries | 4 hours |
| Wellness (past days) | Never expires |
| Wellness (today) | 1 hour |
| Zones | 24 hours |

Use the `clear_cache` tool to force fresh data. On Lambda it only clears the instance that handles the call, so other warm instances may briefly keep older data.

## Known limitations

- **Strava-sourced activities** return no data via the intervals.icu API (Strava licensing restriction). Activities synced from Garmin, Wahoo, or uploaded directly work fine.
- **No field selection** on the activities API — full objects are fetched and cached.

## Tech stack

- TypeScript / Node.js
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for caching
- stdio transport locally; stateless Streamable HTTP with OAuth on AWS Lambda (Express, serverless-http, SAM)

## License

MIT
