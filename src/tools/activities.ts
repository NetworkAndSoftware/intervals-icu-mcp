import { z } from "zod";
import { TTL } from "../cache.js";
import { activityId, getActivity, type Tools } from "./accounts.js";

type Json = Record<string, unknown>;

const withoutNulls = (record: Json) => Object.fromEntries(Object.entries(record).filter(([, v]) => v != null));

export function registerActivityTools(tools: Tools) {
  tools.add(
    "get_activities",
    "List activities in a date range. Returns activity summaries including id, date, name, type, duration, distance, TSS, IF, NP, avg power, avg HR.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-01-31)"),
      type: z.string().optional().describe('Optional activity type filter (e.g. "Ride", "Run", "VirtualRide")'),
      query: z.string().optional().describe("Optional search string or /regex/ to filter activities by name (case-insensitive)"),
      source: z.string().optional().describe('Only activities from this source, exact match, e.g. "WAHOO", "GARMIN_CONNECT", "OAUTH_CLIENT", "STRAVA"'),
      oauth_client_name: z.string().optional().describe("Only activities uploaded by this app (exact match)"),
      fields: z.array(z.string()).optional().describe('Return only these fields of each activity (plus id), e.g. ["name", "start_date_local", "icu_training_load"]'),
    },
    async ({ oldest, newest, type, query, source, oauth_client_name, fields }, { client, cache }) => {
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
      if (source != null) data = data.filter((a: any) => a.source === source);
      if (oauth_client_name != null) data = data.filter((a: any) => a.oauth_client_name === oauth_client_name);

      // A full activity is ~8K characters, so a list of them fills the context quickly
      if (fields) {
        const keep = ["id", ...fields.filter(f => f !== "id")];
        const picked = data.map((a: any) => Object.fromEntries(keep.filter(k => k in a).map(k => [k, a[k]])));
        return { content: [{ type: "text", text: JSON.stringify(picked) }] };
      }

      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  tools.add(
    "get_activity",
    "Get full detail for a single activity including intervals (start_time/end_time: seconds from the start; start_index/end_index: stream positions), laps, and all summary metrics.",
    {
      id: activityId.describe("Activity ID"),
    },
    async ({ id }, account) => {
      // About half of each interval's ~80 fields are null
      const data = (await getActivity(account, id)).map(activity => {
        const out = { ...activity };
        for (const k of ["icu_intervals", "icu_groups"]) {
          if (Array.isArray(out[k])) out[k] = (out[k] as Json[]).map(withoutNulls);
        }
        return out;
      });
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
