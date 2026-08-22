import { z } from "zod";
import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerFitnessTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_fitness",
    "Get fitness/fatigue summary for a date range. Returns aggregated training data including CTL (fitness), ATL (fatigue), TSB (form), ramp rate, total TSS, time, distance, elevation, calories, eFTP, and time-in-zones. Includes breakdowns by activity category (Ride, Rowing, etc). This data includes ALL activities even those locked by Strava.",
    {
      start: z.string().describe("Start date (ISO format, e.g. 2024-01-01). Use a Monday for weekly alignment."),
      end: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
    },
    async ({ start, end }) => {
      const cacheKey = `fitness:${start}:${end}`;
      const cached = cache.get<unknown[]>(cacheKey);
      if (cached) {
        const own = cached.filter((f: any) => f.athlete_id === client.athleteId);
        return { content: [{ type: "text", text: JSON.stringify(own, null, 2) }] };
      }

      const data = await client.getFitness(start, end);
      cache.set(cacheKey, data, TTL.FOUR_HOURS);
      const own = (data as any[]).filter((f: any) => f.athlete_id === client.athleteId);
      return { content: [{ type: "text", text: JSON.stringify(own, null, 2) }] };
    }
  );

  server.tool(
    "get_events",
    "Get calendar events for a date range, including planned workouts and weekly load targets. TARGET events contain load_target fields showing planned TSS by activity type. Use alongside get_fitness to compare planned vs actual training load.",
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
    },
    async ({ oldest, newest }) => {
      const cacheKey = `events:${oldest}:${newest}`;
      const cached = cache.get<unknown[]>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const data = await client.getEvents(oldest, newest);
      cache.set(cacheKey, data, TTL.ONE_HOUR);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
