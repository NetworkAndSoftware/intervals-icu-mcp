# intervals.icu MCP Server

## Project Overview

An MCP (Model Context Protocol) server that exposes intervals.icu cycling/rowing data as tools Claude can call. Runs locally via stdio transport for use with Claude Code and Claude Desktop, and can also be deployed to AWS Lambda as an OAuth-protected remote server for claude.ai custom connectors (web and mobile), shared by several athletes who each sign in to their own claude.ai account and see only their own intervals.icu data.

The user is an active road cyclist who tracks with a Garmin Edge 840 and Wahoo TICKR chest strap, syncing to Garmin Connect and then to intervals.icu. They also row (EXR/concept2). They race USAC-permitted events and care about power data, training load (CTL/ATL/TSB), and performance trends.

## Tech Stack

- **Runtime:** Node.js (TypeScript)
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Cache:** SQLite via `better-sqlite3` (stdio); in memory, per athlete, on Lambda
- **HTTP client:** `fetch` (native in Node 18+)
- **Transport:** stdio locally; stateless Streamable HTTP (Express + `serverless-http`) on Lambda
- **Build:** `npx tsc` → outputs to `dist/`; `npm run build:lambda` (esbuild) → single-file bundle in `dist-lambda/`
- **Hosting (optional):** AWS Lambda + Function URL via SAM (`template.yaml`), secrets in SSM Parameter Store

## Authentication

intervals.icu uses HTTP Basic auth:
- **Username:** `API_KEY` (literal string, not the athlete ID)
- **Password:** the API key from intervals.icu Settings → Developer Settings
- **Athlete ID:** used in URL path, not in auth header

Credentials stored in `.env` (gitignored) for the local server:
```
INTERVALS_ATHLETE_ID=i12345
INTERVALS_API_KEY=your_api_key_here
```

On Lambda there's no `.env`: each signed-in user's athlete ID and API key come from SSM (see Remote Hosting).

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
| `get_athlete_settings` | Profile (weight, resting HR, height, DOB, units) + per-sport thresholds (FTP, W′, Pmax, LTHR, max HR, threshold pace) and zones | 24 hours |
| `get_coaching_context` | Compact aggregated snapshot for LLM coaching — current fitness, planned vs actual, wellness trends, activity summaries, optional season progression | 1–4 hours |

### Write Tools

| Tool | Description |
|------|-------------|
| `create_event` | Create a workout, target, note, race, or rest day on the calendar |
| `update_event` | Update fields on an existing event |
| `delete_event` | Delete a planned workout or event by event ID |
| `set_weekly_target` | Set/update weekly load/duration/distance target (creates or updates TARGET event) |
| `update_athlete_settings` | Update profile weight, resting HR, height, date of birth |
| `update_sport_settings` | Update one sport's FTP, indoor FTP, W′, Pmax, LTHR, max HR, threshold pace, HR/power zones |
| `upload_activity` | Upload a completed activity file (.fit/.gpx/.tcx). Local only — not registered on Lambda |
| `delete_activity` | Delete an activity by activity ID |

### Utility Tools

| Tool | Description |
|------|-------------|
| `clear_cache` | Clear the cache so fresh data is fetched (on Lambda: only the current athlete's cache on the instance that handles the call) |

## Known Issues & Gotchas

### API paths can move without notice (2026-07 and 2026-08 breakage)
The `/api/v1/athlete/{id}/activities/{activityId}/streams` and `/api/v1/athlete/{id}/power-curve` endpoints from the original docs both started 404ing — intervals.icu moved them to `/api/v1/activity/{activityId}/streams` (no `/athlete/{id}` prefix, activity IDs are global) and `/api/v1/athlete/{id}/activity-power-curves`. `/api/v1/athlete/{id}/zones` also started 404ing and has no direct replacement — zone data now lives on `/api/v1/athlete/{id}/sport-settings`, which returns one entry per activity type (Ride, Run, Rowing, etc.) with `power_zones`, `power_zone_names`, `hr_zones`, `hr_zone_names`, `ftp`, `lthr`, and a lot of other per-sport config alongside the zone fields. If a tool suddenly 404s on every input, don't assume the service is down — fetch the live OpenAPI spec at `https://intervals.icu/api/v1/docs` (JSON) and grep it for the resource name; the static docs page at api-docs.html is a JS app WebFetch can't render, but the spec JSON behind it is authoritative and current.

### Sport settings: updating by type name can hit the wrong entry
`PUT /sport-settings/{id}` accepts an activity type instead of the numeric ID, but a type no entry lists (e.g. `Kitesurf`) silently updates the **Other** entry instead of failing. `update_sport_settings` therefore lists the entries, matches the type itself, and PUTs by numeric ID. Other behaviour, verified 2026-10 against a throwaway entry:
- PUT is a partial update: only the fields sent change (same for `PUT /athlete/{id}`, per its `AthleteUpdateDTO`).
- `recalcHrZones` is a required query param. `true` recomputes `hr_zones` from `lthr` with intervals.icu's default percentages, discarding custom bounds; explicit `hr_zones` in the body win over it.
- The last HR zone always follows `max_hr`, even with `recalcHrZones=false`.
- Setting `ftp` on an entry without power zones adds the default ones.
- Updates don't reprocess existing activities; `PUT /sport-settings/{id}/apply` does that (not exposed).

`GET /athlete/{id}` includes the API key, email and third-party tokens, so `get_athlete_settings` and `update_athlete_settings` return an allowlist of fields, never the raw record.

### athlete-summary returns followed athletes
The `/athlete-summary` endpoint returns weekly entries for **all followed athletes** when called with Basic auth (not a bearer token). Each entry has `athlete_id` (e.g. `"i458859"`) and `athlete_name`. Always filter by `athlete_id === client.athleteId` before using any data from this endpoint. Both `get_fitness` and `get_coaching_context` apply this filter. Tools must take the athlete from `client`, never from `process.env`: on Lambda each request acts for whichever user signed in.

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
├── template.yaml          # SAM template: Lambda + Function URL + log group
├── samconfig.toml         # sam deploy defaults (stack name, S3, capabilities)
├── scripts/
│   ├── build-lambda.mjs   # esbuild bundle of src/lambda.ts → dist-lambda/index.mjs
│   └── users.mjs          # manages users + signing secret in SSM, recycles the Lambda
├── src/
│   ├── index.ts           # Local entry point: stdio (default) or --http for testing the remote setup
│   ├── lambda.ts          # Lambda entry point: loads SSM secrets, wraps the HTTP app
│   ├── server.ts          # createMcpServer(): registers all tools + clear_cache
│   ├── http.ts            # Express app: OAuth routes, /login, stateless /mcp; per-athlete client + cache
│   ├── oauth.ts           # Multi-user OAuth provider (name + password login, signed stateless tokens)
│   ├── api.ts             # intervals.icu API client (all HTTP methods)
│   ├── cache.ts           # Cache interface, TTLs, in-memory cache (Lambda / --http)
│   ├── sqlite-cache.ts    # SQLite cache (stdio)
│   ├── types.ts           # TypeScript interfaces (StreamType)
│   └── tools/
│       ├── activities.ts  # get_activities, get_activity, get_activity_streams
│       ├── fitness.ts     # get_fitness, get_events
│       ├── power-curve.ts # get_power_curve
│       ├── wellness.ts    # get_wellness
│       ├── zones.ts       # get_athlete_zones
│       ├── settings.ts    # get_athlete_settings, update_athlete_settings, update_sport_settings
│       ├── upload.ts      # create_event, update_event, delete_event, delete_activity,
│       │                  # upload_activity, set_weekly_target
│       └── coaching.ts    # get_coaching_context (aggregated coaching snapshot)
├── dist/                  # Compiled JS (gitignored)
├── dist-lambda/           # Lambda bundle (gitignored)
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

On Lambda (and `--http`) the cache is `MemoryCache` instead: one per athlete (cache keys don't include the athlete ID, so a shared cache would leak data between users), per instance, lost on cold start, capped at 500 entries. `better-sqlite3` is a native module built for Windows here, and Lambda's disk is ephemeral anyway.

## MCP Server Registration

In Claude Desktop or Claude Code settings:
```json
{
  "mcpServers": {
    "intervals-icu": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "C:/data/unsynced/src/intervals-icu-mcp"
    }
  }
}
```

Claude Desktop must be restarted to pick up new/changed tool schemas.

The Lambda-hosted server is added in claude.ai instead: Settings → Connectors → Add custom connector, with the `McpServerUrl` stack output (ends in `/mcp`). Each athlete adds it in their own claude.ai account.

## API Reference

Docs: https://intervals.icu/api-docs.html

Key endpoints used:
- `GET /api/v1/athlete/{id}` — athlete profile plus `sportSettings`; `scripts/users.mjs` uses it to validate credentials
- `PUT /api/v1/athlete/{id}` — update profile fields (`icu_weight`, `icu_resting_hr`, `height`, `icu_date_of_birth`)
- `GET /api/v1/athlete/{id}/activities` — list activities
- `GET /api/v1/athlete/{id}/activities/{activityId}` — activity detail
- `GET /api/v1/activity/{activityId}/streams` — streams (not under `/athlete/{id}` — activity IDs are globally unique)
- `GET /api/v1/athlete/{id}/athlete-summary` — weekly fitness aggregates
- `GET /api/v1/athlete/{id}/events` — calendar events
- `GET /api/v1/athlete/{id}/activity-power-curves` — power curve (best power per duration for activities in a date range)
- `GET /api/v1/athlete/{id}/wellness` — wellness
- `GET /api/v1/athlete/{id}/sport-settings` — zones (per-sport, includes power/HR zones plus other config; `/zones` 404s)
- `PUT /api/v1/athlete/{id}/sport-settings/{settingsId}?recalcHrZones=` — update one sport's settings (by numeric ID, see Known Issues)
- `POST /api/v1/athlete/{id}/activities` — upload activity (multipart)
- `POST /api/v1/athlete/{id}/events` — create event
- `PUT /api/v1/athlete/{id}/events/{eventId}` — update event
- `DELETE /api/v1/athlete/{id}/events/{eventId}` — delete event
- `DELETE /api/v1/athlete/{id}/activities/{activityId}` — delete activity

## Remote Hosting (AWS Lambda)

Setup and day-to-day commands are in README.md. Design notes and gotchas:

- **Why OAuth:** claude.ai custom connectors (which also serve the mobile app) support only OAuth (DCR/CIMD, or client ID/secret) or no auth. Static header credentials exist but are an org-only beta. So `oauth.ts` is a minimal authorization server on top of the SDK's `mcpAuthRouter`: `/authorize` shows a name + password page, `POST /login` checks it against the users list and redirects with a code.
- **Users:** each user is `{ name, password, athleteId, apiKey }`, one per claude.ai account. Tokens carry the user's name (`sub`); `verifyAccessToken` returns it as `AuthInfo.extra.user`, and `/mcp` picks that athlete's `IntervalsClient` and `MemoryCache`. The intervals.icu API key never leaves the server.
- **Stateless OAuth:** client IDs, login requests, codes, and access/refresh tokens are HMAC-signed claims (key: `MCP_SIGNING_SECRET`), so no database is needed. Codes and tokens also carry `pv`, an HMAC fingerprint of the user's password, checked against the current users list: changing a user's password or removing them invalidates only their tokens; rotating the signing secret signs out everyone. A single token can't be revoked, auth codes aren't single-use (2-minute expiry + PKCE instead), and confidential clients get a secret derived from their client ID.
- **Redirect URI allowlist:** DCR only accepts `https://claude.ai/api/mcp/auth_callback` (override with `OAUTH_REDIRECT_URIS`, comma-separated — e.g. add a localhost callback to test with MCP Inspector).
- **Origin:** the OAuth metadata needs absolute URLs, but a Lambda can't know its own Function URL at deploy time (circular reference in CloudFormation). `http.ts` takes it from the `Host` header on the first request, only when it matches `*.lambda-url.*.on.aws` (AWS routes on it, so it can't be spoofed); `PUBLIC_URL` overrides this, e.g. for a custom domain. Routes are therefore built lazily, which is why the rate limiters have `creationStack` validation off.
- **serverless-http + MCP SDK:** the SDK's `StreamableHTTPServerTransport` converts requests via `@hono/node-server`, which reads `req.rawHeaders`; serverless-http only fills `req.headers`. `lambda.ts` rebuilds `rawHeaders` in serverless-http's `request` hook — without it every MCP call fails with "Not Acceptable".
- **Stateless MCP:** a new `McpServer` + transport per request (`sessionIdGenerator: undefined`, `enableJsonResponse: true`), so any instance can serve any call; GET/DELETE `/mcp` return 405.
- **No local files remotely:** `upload_activity` isn't registered and `create_event` rejects `file_path` when remote — reading paths on the Lambda host (e.g. `/proc/self/environ`) would leak its AWS credentials.
- **Secrets:** two SSM SecureStrings under `/intervals-icu-mcp/`: `USERS` (JSON array of users, parsed by `parseUsers` in `http.ts`; standard-tier limit 4 KB ≈ 20 users) and `MCP_SIGNING_SECRET`. Read once per cold start; `scripts/users.mjs` recycles the function after every change so it applies immediately, and validates credentials against `GET /api/v1/athlete/{id}` (200 ok, 401 bad key, 403 key belongs to another athlete) before saving.
- **Deploy:** `sam deploy` zips `dist-lambda/` as-is — don't run `sam build` (there's no package.json in `dist-lambda/`). SAM adds both Function URL permissions (`lambda:InvokeFunctionUrl` and, required since Oct 2025, `lambda:InvokeFunction`). `@aws-sdk/*` is external in the bundle because the Node.js runtime provides it.
- **Testing without AWS:** run the bundle under Node with a loader hook (`node --import`, `module.register`) that swaps `@aws-sdk/client-ssm` for a file-backed stub, and feed it Function URL (payload v2) events through the whole OAuth flow. Stub `@aws-sdk/client-lambda` too to run `scripts/users.mjs` against the same fake store. Or run `npm run start:http` for the same app on localhost.

## Development Notes

- Build with `npx tsc`. No test framework yet.
- Lambda: `npm run deploy` (= `build:lambda` + `sam deploy`); users and secrets via `npm run users`.
- The server is a long-lived process, not spawned per tool call: Claude Desktop starts it at launch and keeps it running until Desktop quits (observed running 28+ hours). It holds `cache.db` open in WAL mode the whole time, so `cache.db-wal`/`cache.db-shm` are live, locked files while Desktop is running.
- Keep the repo out of cloud-synced folders (Proton Drive, OneDrive, etc.). It lived in Proton Drive until 2026-09, where sync repeatedly name-clashed the live `cache.db-wal` and silently dropped the `[core]` section from `.git/config`.
- Error handling maps HTTP status codes to meaningful messages (401 → auth failure, 404 → not found, 429 → rate limited).
- Activities from Strava are effectively opaque — plan around this limitation.
