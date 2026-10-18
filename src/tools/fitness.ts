import { z } from "zod";
import { TTL } from "../cache.js";
import type { Tools } from "./accounts.js";

export function registerFitnessTools(tools: Tools) {
  tools.add(
    "get_fitness",
    "Get fitness/fatigue summary for a date range. Returns aggregated training data including CTL (fitness), ATL (fatigue), TSB (form), ramp rate, total TSS, time, distance, elevation, calories, eFTP, and time-in-zones. Includes breakdowns by activity category (Ride, Rowing, etc). This data includes ALL activities even those locked by Strava.",
    {
      start: z.string().describe("Start date (ISO format, e.g. 2024-01-01). Use a Monday for weekly alignment."),
      end: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
    },
    async ({ start, end }, { client, cache }) => {
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

  tools.add(
    "get_events",
    `Get calendar events for a date range, including planned workouts, races and weekly load targets. TARGET events contain load_target fields showing planned TSS by activity type. Use alongside ${tools.name("get_fitness")} to compare planned vs actual training load.`,
    {
      oldest: z.string().describe("Start date (ISO format, e.g. 2024-01-01)"),
      newest: z.string().describe("End date (ISO format, e.g. 2024-03-01)"),
      category: z.string().optional().describe('Only return events of this category, e.g. "WORKOUT", "NOTE", "TARGET", or "RACE" for races of any priority (RACE_A, RACE_B, RACE_C)'),
      include_workout_doc: z.boolean().optional().describe("Include each planned workout's structured steps (workout_doc). Off by default: it is most of the response, and the description holds the same workout as text. Turn it on to copy a workout to another app (e.g. EXR, which takes workout_doc.steps)."),
    },
    async ({ oldest, newest, category, include_workout_doc }, { client, cache }) => {
      const cacheKey = `events:${oldest}:${newest}`;
      let data = cache.get<Record<string, unknown>[]>(cacheKey);
      if (!data) {
        data = await client.getEvents(oldest, newest) as Record<string, unknown>[];
        cache.set(cacheKey, data, TTL.ONE_HOUR);
      }

      if (category) {
        const c = category.toUpperCase();
        data = data.filter(e => c === "RACE" ? String(e.category).startsWith("RACE_") : e.category === c);
      }
      // About a third of each event's fields are null; leaving them and workout_doc out
      // cuts a month of events from ~145K characters to ~40K
      const events = data.map(e => Object.fromEntries(
        Object.entries(e).filter(([k, v]) => v != null && (include_workout_doc || k !== "workout_doc"))
      ));
      return { content: [{ type: "text", text: JSON.stringify(events) }] };
    }
  );
}
