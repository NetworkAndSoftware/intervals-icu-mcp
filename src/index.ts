import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IntervalsClient } from "./api.js";
import { Cache } from "./cache.js";
import { registerActivityTools } from "./tools/activities.js";
import { registerFitnessTools } from "./tools/fitness.js";
import { registerPowerCurveTools } from "./tools/power-curve.js";
import { registerWellnessTools } from "./tools/wellness.js";
import { registerZonesTools } from "./tools/zones.js";
import { registerUploadTools } from "./tools/upload.js";
import { registerCoachingTools } from "./tools/coaching.js";

const athleteId = process.env.INTERVALS_ATHLETE_ID;
const apiKey = process.env.INTERVALS_API_KEY;

if (!athleteId || !apiKey) {
  console.error(
    "Missing INTERVALS_ATHLETE_ID or INTERVALS_API_KEY in environment. " +
      "Copy .env.example to .env and fill in your credentials."
  );
  process.exit(1);
}

const client = new IntervalsClient(athleteId, apiKey);
const cache = new Cache();

const server = new McpServer({
  name: "intervals-icu",
  version: "1.0.0",
});

registerActivityTools(server, client, cache);
registerFitnessTools(server, client, cache);
registerPowerCurveTools(server, client, cache);
registerWellnessTools(server, client, cache);
registerZonesTools(server, client, cache);
registerUploadTools(server, client);
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("intervals-icu MCP server running on stdio");
