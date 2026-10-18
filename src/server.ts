import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IntervalsClient } from "./api.js";
import type { Cache } from "./cache.js";
import { coachTools, ownTools, type Account } from "./tools/accounts.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerAthleteListTool } from "./tools/athletes.js";
import { registerFitnessTools } from "./tools/fitness.js";
import { registerPowerCurveTools } from "./tools/power-curve.js";
import { registerWellnessTools } from "./tools/wellness.js";
import { registerZonesTools } from "./tools/zones.js";
import { registerSettingsTools } from "./tools/settings.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerCoachingTools } from "./tools/coaching.js";

const INSTRUCTIONS =
  "Tools act on the user's own intervals.icu account, except the coach_ tools, which do the same for athletes the user coaches (coach_list_athletes gives their IDs). " +
  "For anything in another athlete's account, use the coach_ tools, also when all you need is an activity or event ID from it: they have their own permission settings.";

export function createMcpServer(
  client: IntervalsClient,
  cache: Cache,
  { remote = false }: { remote?: boolean } = {}
): McpServer {
  const server = new McpServer(
    {
      name: "intervals-icu",
      version: "1.0.0",
    },
    { instructions: INSTRUCTIONS }
  );

  const own: Account = { client, cache };
  for (const tools of [ownTools(server, own), coachTools(server, own)]) {
    registerActivityTools(tools);
    registerFitnessTools(tools);
    registerPowerCurveTools(tools);
    registerWellnessTools(tools);
    registerZonesTools(tools);
    registerSettingsTools(tools);
    registerUploadTools(tools, { allowLocalFiles: !remote });
    registerCoachingTools(tools);
  }
  registerAthleteListTool(server, own);

  server.tool(
    "clear_cache",
    "Clear the local cache, yours and that of athletes you coach, so that fresh data is fetched from intervals.icu on the next request.",
    {},
    async () => {
      cache.clear();
      return { content: [{ type: "text", text: "Cache cleared." }] };
    }
  );

  return server;
}
