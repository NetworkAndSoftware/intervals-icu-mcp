# intervals.icu MCP Server

## Project Overview

An MCP (Model Context Protocol) server that exposes intervals.icu cycling/rowing data as tools Claude can call. Runs locally via stdio transport for use with Claude Code and Claude Desktop, and can also be deployed to AWS Lambda as an OAuth-protected remote server for claude.ai custom connectors (web and mobile), shared by several athletes who each sign in to their own claude.ai account and see only their own intervals.icu data and that of the athletes they coach.

The user is an active road cyclist who tracks with a Garmin Edge 840 and Wahoo TICKR chest strap, syncing to Garmin Connect and then to intervals.icu. They also row (EXR/concept2). They race USAC-permitted events and care about power data, training load (CTL/ATL/TSB), and performance trends. They also coach several athletes in intervals.icu, so every tool can act on a coached athlete's account too (see Coaching).

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
| `get_events` | Calendar events (planned workouts, races, targets, notes). Optional `category` filter; drops nulls, and `workout_doc` unless `include_workout_doc` | 1 hour |
| `get_power_curve` | Best power for each duration over a date range | 4 hours |
| `get_wellness` | Daily wellness (weight, resting HR, HRV, sleep, mood, etc.) | 1 hour (today), never (past) |
| `get_athlete_zones` | Power and HR zone definitions | 24 hours |
| `get_athlete_settings` | Profile (weight, resting HR, height, DOB, units) + per-sport thresholds (FTP, W′, Pmax, LTHR, max HR, threshold pace) and zones | 24 hours |
| `get_coaching_context` | Compact aggregated snapshot for LLM coaching — current fitness, planned vs actual, wellness trends, activity summaries, optional season progression | 1–4 hours |

### Write Tools

| Tool | Description |
|------|-------------|
| `create_event` | Create any calendar event: workout, race (A/B/C priority), note, target, holiday/sick/injured period, season start, SET_EFTP/SET_FITNESS/FITNESS_DAYS. Shares its fields with `update_event` |
| `update_event` | Change any field of an existing event: date, start time, end date, category, workout structure (description or file), indoor, entered, tags, availability, etc.; remove attachments |
| `delete_event` | Delete a planned workout or event by event ID |
| `set_weekly_target` | Set/update weekly load/duration/distance target (creates or updates TARGET event) |
| `update_athlete_settings` | Update profile weight, resting HR, height, date of birth |
| `update_sport_settings` | Update one sport's FTP, indoor FTP, W′, Pmax, LTHR, max HR, threshold pace, HR/power zones |
| `upload_activity` | Upload a completed activity file (.fit/.gpx/.tcx). Local only — not registered on Lambda |
| `delete_activity` | Delete an activity by activity ID |

### Coaching Tools

Every tool above except `clear_cache` also exists as `coach_<name>` (e.g. `coach_get_activities`, `coach_create_event`), which takes an `athlete_id` and does the same for an athlete the user coaches. Plus:

| Tool | Description | Cache TTL |
|------|-------------|-----------|
| `coach_list_athletes` | The athletes the user coaches (everyone their account follows), with their athlete IDs | 1 hour |

### Utility Tools

| Tool | Description |
|------|-------------|
| `clear_cache` | Clear the cache, coached athletes' data included, so fresh data is fetched (on Lambda: only the current athlete's cache on the instance that handles the call) |

## Known Issues & Gotchas

### API paths can move without notice (2026-07 and 2026-08 breakage)
The `/api/v1/athlete/{id}/activities/{activityId}/streams` and `/api/v1/athlete/{id}/power-curve` endpoints from the original docs both started 404ing — intervals.icu moved them to `/api/v1/activity/{activityId}/streams` (no `/athlete/{id}` prefix, activity IDs are global) and `/api/v1/athlete/{id}/activity-power-curves`. `/api/v1/athlete/{id}/zones` also started 404ing and has no direct replacement — zone data now lives on `/api/v1/athlete/{id}/sport-settings`, which returns one entry per activity type (Ride, Run, Rowing, etc.) with `power_zones`, `power_zone_names`, `hr_zones`, `hr_zone_names`, `ftp`, `lthr`, and a lot of other per-sport config alongside the zone fields. If a tool suddenly 404s on every input, don't assume the service is down — fetch the live OpenAPI spec at `https://intervals.icu/api/v1/docs` (JSON) and grep it for the resource name; the static docs page at api-docs.html is a JS app WebFetch can't render, but the spec JSON behind it is authoritative and current. Deleting an activity isn't under `/athlete/{id}` either: there the activity path is GET-only and answers DELETE with 405 (found 2026-10); it's `DELETE /api/v1/activity/{activityId}`.

### Sport settings: updating by type name can hit the wrong entry
`PUT /sport-settings/{id}` accepts an activity type instead of the numeric ID, but a type no entry lists (e.g. `Kitesurf`) silently updates the **Other** entry instead of failing. `update_sport_settings` therefore lists the entries, matches the type itself, and PUTs by numeric ID. Other behaviour, verified 2026-10 against a throwaway entry:
- PUT is a partial update: only the fields sent change (same for `PUT /athlete/{id}`, per its `AthleteUpdateDTO`).
- `recalcHrZones` is a required query param. `true` recomputes `hr_zones` from `lthr` with intervals.icu's default percentages, discarding custom bounds; explicit `hr_zones` in the body win over it.
- The last HR zone always follows `max_hr`, even with `recalcHrZones=false`.
- Setting `ftp` on an entry without power zones adds the default ones.
- Updates don't reprocess existing activities; `PUT /sport-settings/{id}/apply` does that (not exposed).

`GET /athlete/{id}` includes the API key, email and third-party tokens, so `get_athlete_settings` and `update_athlete_settings` return an allowlist of fields, never the raw record.

### Coaching
A coach's own API key reaches the accounts of the athletes who accepted them as coach: same Basic auth, with the coached athlete's ID in the path (per the intervals.icu forum; not yet verified against a live coached account as of 2026-10). Other athletes are refused, presumably with a 403, which `IntervalsApiError` explains.

- **Why separate tools:** Claude keeps permission settings per tool (Claude Code allowlists, claude.ai's per-tool "always allow"), so the user approves changes to an athlete's account separately from their own. `src/tools/accounts.ts` registers each tool twice, through `ownTools` and `coachTools`; tool modules call `tools.add(...)` and get the account as the handler's second argument. Descriptions that mention another tool use `tools.name("get_events")` so the coach version points to `coach_get_events`.
- **`athlete_id`:** must match `/^i?[1-9]\d*$/` (no `0`, which intervals.icu reads as "the key's own athlete", and no path tricks), and must not be the user's own ID.
- **IDs from another account:** activity streams and deletes (`/activity/{id}/streams`, `DELETE /activity/{id}`) have no athlete in the path, and intervals.icu may not check that an activity or event ID belongs to the athlete in `/athlete/{id}/...` either. Without a check, `delete_event` given a coached athlete's event ID could change their account under the own-account tool's permission. So tools taking an activity or event ID first fetch it and compare its owner (`icu_athlete_id` on activities, `athlete_id` on events) with the account the tool acts on (`getActivity`/`getEvent` in `accounts.ts`). Records without the field are let through. `GET /athlete/{id}/activities/{ids}` answers with a list and leaves out IDs it doesn't find (no 404), so `getActivity` checks every record in it and refuses an empty one.
- **Coached athletes' clients:** `client.forAthlete(id)` reuses the key, one client per athlete so their own time zone is fetched once ("today" is the coached athlete's date). Never use another server user's key for a coached athlete: the signed-in user's key is what intervals.icu authorizes.
- **Listing:** `coach_list_athletes` reads the user's own athlete-summary (below) and lists every other athlete in it. intervals.icu doesn't say there which of those the user coaches and which they only follow.

### athlete-summary returns followed athletes
The `/athlete-summary` endpoint returns weekly entries for **all followed athletes** when called with Basic auth (not a bearer token). Each entry has `athlete_id` (e.g. `"i458859"`) and `athlete_name`. Always filter by `athlete_id === client.athleteId` before using any data from this endpoint. Both `get_fitness` and `get_coaching_context` apply this filter. Tools must take the athlete from `client`, never from `process.env`: on Lambda each request acts for whichever user signed in.

### Strava-locked activities
Activities sourced from Strava (`source: "STRAVA"`) return no name, type, TSS, or any useful data via the API. This is a Strava API licensing restriction. The `get_fitness` endpoint includes their load in aggregates, but individual activity detail is inaccessible. Workaround: delete and re-upload the `.fit` file directly so it comes in as `FILE_UPLOAD`.

### Event categories
There is no `RACE` or `REST_DAY` category: races are `RACE_A`, `RACE_B` or `RACE_C` (priority), and days off are `HOLIDAY`, `SICK` or `INJURED`. The others: `WORKOUT`, `NOTE`, `TARGET`, `SEASON_START`, `SET_EFTP`, `SET_FITNESS`, `FITNESS_DAYS` (plus `PLAN`, made by applying a plan). An unknown category doesn't get a validation error — the POST fails with a bare `400 {"error":"JSON parse error"}` (verified 2026-10 for `RACE` and `REST_DAY`).

### Updating events (verified 2026-10 against throwaway events)
`PUT /events/{id}` is a partial update: fields left out or `null` keep their value, `""` clears a text field (`color`, `description`), `[]` clears `tags`/`attachments`. Unlike `POST /events`, its 422s carry a real message (`{"error":"type is required for category RACE_A"}`), which `IntervalsApiError` passes on.
- **Dates:** `end_date_local` is exclusive (a one-day event ends at midnight the next day). Moving `start_date_local` moves a one-day event's end with it but leaves a multi-day event's end where it was, so `update_event` shifts it itself.
- **Time of day:** only workouts and races keep a time in `start_date_local`; notes and days off are reset to midnight. A timed event's end is start + `moving_time` (1 h without one) and can't be set. Sending a date with `T00:00:00` makes the event all-day again, so `update_event` keeps the current time when only the date changes.
- **Category:** workouts, races, notes and days off convert freely, but workouts and races need `type`, and only `WORKOUT` may have a `sub_type`. `TARGET`, `SEASON_START`, `SET_EFTP`, `SET_FITNESS` and `FITNESS_DAYS` events can't change category at all (`SET_FITNESS`/`FITNESS_DAYS` also rename themselves, e.g. "Fitness 42d Fatigue 7d").
- **Structure:** a changed `description` is re-parsed into `workout_doc`, `moving_time` and `icu_training_load` (overriding a load set earlier). A workout file (`filename` + `file_contents_base64`) also works and replaces the name and description. Writing `workout_doc` directly changes the steps but not the description, duration or load, so it isn't exposed.
- **Attachments:** files are uploaded with `POST /api/attachment` (multipart, 20 MB), which isn't in the public API and returns 401 for the API key, so only the web app can add them. `PUT` accepts `attachments` only as full objects from that upload (`id`, `filename`, `mimetype`, `url`); `update_event` can therefore only remove them, by sending the rest.

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
│   ├── dates.ts           # YYYY-MM-DD helpers (addDays, getMonday, todayIn)
│   ├── types.ts           # TypeScript interfaces (StreamType)
│   └── tools/
│       ├── accounts.ts    # Registers each tool for own account + as coach_<name>; owner checks for IDs
│       ├── athletes.ts    # coach_list_athletes
│       ├── activities.ts  # get_activities, get_activity, get_activity_streams
│       ├── fitness.ts     # get_fitness, get_events
│       ├── power-curve.ts # get_power_curve
│       ├── wellness.ts    # get_wellness
│       ├── zones.ts       # get_athlete_zones
│       ├── settings.ts    # get_athlete_settings, update_athlete_settings, update_sport_settings
│       ├── upload.ts      # create_event, update_event, delete_event, delete_activity,
│       │                  # upload_activity, set_weekly_target
│       └── coaching.ts    # get_coaching_context (aggregated coaching snapshot)
├── test/                  # node:test tests, run against dist/ (npm test)
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

Write tools invalidate what they make stale: event writes drop every `events:` and `fitness:` key (SET_FITNESS, SET_EFTP and FITNESS_DAYS events change the fitness numbers), activity uploads/deletes drop `activities:`, `fitness:` and `power_curve:` (plus that activity's `activity:`/`streams:` keys), settings updates drop `zones`/`athlete_settings`. On Lambda this only reaches the instance that handled the write.

Coached athletes' data is in the same cache under `coached:{athleteId}:` + the usual key (`PrefixedCache`), so a coach_ write only invalidates that athlete's entries. The athlete list itself is `coached_athletes`.

### Dates and time zones
"Today" is the athlete's local date (`client.today()`, from the profile's `timezone`, fetched once per client), never `new Date().toISOString()`: that's UTC, which is already tomorrow from late afternoon in the Americas, so Sunday-evening coaching context showed next week and today's wellness got the never-expires TTL for past days. Date arithmetic lives in `src/dates.ts` and works on `YYYY-MM-DD` strings in UTC, so it doesn't depend on the server's own time zone.

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
- `GET /api/v1/athlete/{id}/activities/{activityId}` — activity detail (takes a comma-separated list of IDs, returns a list)
- `GET /api/v1/activity/{activityId}/streams` — streams (not under `/athlete/{id}` — activity IDs are globally unique)
- `GET /api/v1/athlete/{id}/athlete-summary` — weekly fitness aggregates
- `GET /api/v1/athlete/{id}/events` — calendar events
- `GET /api/v1/athlete/{id}/activity-power-curves` — power curve (best power per duration for activities in a date range)
- `GET /api/v1/athlete/{id}/wellness` — wellness
- `GET /api/v1/athlete/{id}/sport-settings` — zones (per-sport, includes power/HR zones plus other config; `/zones` 404s)
- `PUT /api/v1/athlete/{id}/sport-settings/{settingsId}?recalcHrZones=` — update one sport's settings (by numeric ID, see Known Issues)
- `POST /api/v1/athlete/{id}/activities` — upload activity (multipart)
- `POST /api/v1/athlete/{id}/events` — create event
- `GET /api/v1/athlete/{id}/events/{eventId}` — one event (owner check before update/delete; `update_event` also uses it to move events and remove attachments)
- `PUT /api/v1/athlete/{id}/events/{eventId}` — update event (partial, see Known Issues)
- `DELETE /api/v1/athlete/{id}/events/{eventId}` — delete event
- `DELETE /api/v1/activity/{activityId}` — delete activity (not under `/athlete/{id}`, which answers DELETE with 405)

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

- Build with `npx tsc`. `npm test` builds and runs `test/*.test.mjs` with Node's built-in test runner against `dist/`; `fetch` is stubbed, so nothing reaches intervals.icu.
- Lambda: `npm run deploy` (= `build:lambda` + `sam deploy`); users and secrets via `npm run users`.
- The server is a long-lived process, not spawned per tool call: Claude Desktop starts it at launch and keeps it running until Desktop quits (observed running 28+ hours). It holds `cache.db` open in WAL mode the whole time, so `cache.db-wal`/`cache.db-shm` are live, locked files while Desktop is running.
- Keep the repo out of cloud-synced folders (Proton Drive, OneDrive, etc.). It lived in Proton Drive until 2026-09, where sync repeatedly name-clashed the live `cache.db-wal` and silently dropped the `[core]` section from `.git/config`.
- Error handling maps HTTP status codes to meaningful messages (401 → auth failure, 404 → not found, 429 → rate limited).
- Activities from Strava are effectively opaque — plan around this limitation.
