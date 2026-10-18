import { z } from "zod";
import { TTL } from "../cache.js";
import { activityId, getActivity, type Tools } from "./accounts.js";

export function registerActivityTools(tools: Tools) {
  tools.add(
    "get_activities",
    "List activities in a date range. Returns activity summaries including id, date, name, type, duration, distance, TSS, IF, NP, avg power, avg HR.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-01-31)"),
      type: z.string().optional().describe('Optional activity type filter (e.g. "Ride", "Run", "VirtualRide")'),
      query: z.string().optional().describe("Optional search string or /regex/ to filter activities by name (case-insensitive)"),
    },
    async ({ oldest, newest, type, query }, { client, cache }) => {
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

  tools.add(
    "get_activity",
    "Get full detail for a single activity including intervals, laps, and all summary metrics.",
    {
      id: activityId.describe("Activity ID"),
    },
    async ({ id }, account) => {
      const data = await getActivity(account, id);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  tools.add(
    "get_activity_streams",
    "Get time-series data for an activity (power, heart rate, cadence, GPS, altitude, etc.).",
    {
      id: activityId.describe("Activity ID"),
      types: z.array(z.string()).describe('Stream types to fetch (e.g. ["watts", "heartrate", "cadence", "altitude", "distance", "time"])'),
    },
    async ({ id, types }, account) => {
      const { client, cache } = account;
      // The streams path has no athlete in it, so check whose activity this is first
      await getActivity(account, id);

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
