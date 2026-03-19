import { z } from "zod";
import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerActivityTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_activities",
    "List activities in a date range. Returns activity summaries including id, date, name, type, duration, distance, TSS, IF, NP, avg power, avg HR.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-01-31)"),
      type: z.string().optional().describe('Optional activity type filter (e.g. "Ride", "Run", "VirtualRide")'),
      query: z.string().optional().describe("Optional search string or /regex/ to filter activities by name (case-insensitive)"),
    },
    async ({ oldest, newest, type, query }) => {
      const cacheKey = `activities:${oldest}:${newest}${type ? `:${type}` : ""}`;
      const cached = cache.get<unknown[]>(cacheKey);
      let data: unknown[];
      if (cached) {
        data = cached;
      } else {
        data = await client.getActivities(oldest, newest, type);
        cache.set(cacheKey, data, TTL.ONE_HOUR);
      }

      if (query) {
        const regexMatch = query.match(/^\/(.+)\/([gimsuy]*)$/);
        const pattern = regexMatch
          ? new RegExp(regexMatch[1], regexMatch[2].includes("i") ? regexMatch[2] : regexMatch[2] + "i")
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        data = data.filter((a: any) => a.name && pattern.test(a.name));
      }

      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_activity",
    "Get full detail for a single activity including intervals, laps, and all summary metrics.",
    {
      id: z.string().describe("Activity ID"),
    },
    async ({ id }) => {
      const cacheKey = `activity:${id}`;
      const cached = cache.get<unknown>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getActivity(id);
      cache.set(cacheKey, data, TTL.NEVER);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_activity_streams",
    "Get time-series data for an activity (power, heart rate, cadence, GPS, altitude, etc.).",
    {
      id: z.string().describe("Activity ID"),
      types: z.array(z.string()).describe('Stream types to fetch (e.g. ["watts", "heartrate", "cadence", "altitude", "distance", "time"])'),
    },
    async ({ id, types }) => {
      const typesKey = [...types].sort().join(",");
      const cacheKey = `streams:${id}:${typesKey}`;
      const cached = cache.get<unknown>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getActivityStreams(id, types as import("../types.js").StreamType[]);
      cache.set(cacheKey, data, TTL.NEVER);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
