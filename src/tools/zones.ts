import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerZonesTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_athlete_zones",
    "Get the athlete's power and heart rate zone configuration.",
    {},
    async () => {
      const cacheKey = "zones";
      const cached = cache.get<unknown[]>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getZones();
      cache.set(cacheKey, data, TTL.ONE_DAY);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
