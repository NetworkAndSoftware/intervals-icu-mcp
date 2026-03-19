import { z } from "zod";
import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerWellnessTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_wellness",
    "Get wellness entries (weight, resting HR, HRV, sleep, mood, readiness, etc.) for a date range.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
    },
    async ({ oldest, newest }) => {
      const today = new Date().toISOString().slice(0, 10);
      const includesToday = newest >= today;
      const ttl = includesToday ? TTL.ONE_HOUR : TTL.NEVER;

      const cacheKey = `wellness:${oldest}:${newest}`;
      const cached = cache.get<unknown[]>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getWellness(oldest, newest);
      cache.set(cacheKey, data, ttl);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
