import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { IntervalsClient } from "./api.js";
import type { Cache } from "./cache.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerFitnessTools } from "./tools/fitness.js";
import { registerPowerCurveTools } from "./tools/power-curve.js";
import { registerWellnessTools } from "./tools/wellness.js";
import { registerZonesTools } from "./tools/zones.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerCoachingTools } from "./tools/coaching.js";

export function createMcpServer(
  client: IntervalsClient,
  cache: Cache,
  { remote = false }: { remote?: boolean } = {}
): McpServer {
  const server = new McpServer({
    name: "intervals-icu",
    version: "1.0.0",
  });

  registerActivityTools(server, client, cache);
  registerFitnessTools(server, client, cache);
  registerPowerCurveTools(server, client, cache);
  registerWellnessTools(server, client, cache);
  registerZonesTools(server, client, cache);
  registerUploadTools(server, client, { allowLocalFiles: !remote });
  registerCoachingTools(server, client, cache);

  server.tool(
    "clear_cache",
    "Clear the local cache so that fresh data is fetched from intervals.icu on the next request.",
    {},
    async () => {
      cache.clear();
      return { content: [{ type: "text", text: "Cache cleared." }] };
    }
  );

  return server;
}
