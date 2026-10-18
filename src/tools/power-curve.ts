import { z } from "zod";
import { TTL } from "../cache.js";
import type { Tools } from "./accounts.js";

export function registerPowerCurveTools(tools: Tools) {
  tools.add(
    "get_power_curve",
    "Get power duration curve (best power for each duration) over a date range.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
    },
    async ({ oldest, newest }, { client, cache }) => {
      const cacheKey = `power_curve:${oldest}:${newest}`;
      const cached = cache.get<unknown>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getPowerCurve(oldest, newest);
      cache.set(cacheKey, data, TTL.FOUR_HOURS);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
