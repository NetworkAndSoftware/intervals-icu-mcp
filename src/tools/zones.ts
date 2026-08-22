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
    "Get the athlete's power and heart rate zone configuration. Returns one sport-settings entry per activity type (Ride, Run, Rowing, etc.), each with power_zones, power_zone_names, hr_zones, hr_zone_names, ftp, lthr, and related fields.",
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
