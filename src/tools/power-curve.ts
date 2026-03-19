import { z } from "zod";
import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPowerCurveTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_power_curve",
    "Get power duration curve (best power for each duration) over a date range.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
    },
    async ({ oldest, newest }) => {
      const cacheKey = `power_curve:${oldest}:${newest}`;
      const cached = cache.get<unknown>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getPowerCurve(oldest, newest);
      cache.set(cacheKey, data, TTL.FOUR_HOURS);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
