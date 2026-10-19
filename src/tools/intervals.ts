import { z } from "zod";
import { TTL } from "../cache.js";
import { activityCacheKey, activityId, getActivity, type Account, type Tools } from "./accounts.js";
import { withoutNulls } from "./activities.js";

type Json = Record<string, unknown>;

const intervalSchema = z.object({
  start_time: z.number().int().min(0).describe("Start, in seconds from the activity's start (elapsed time, like the start_time of get_activity's intervals)"),
  end_time: z.number().int().describe("End, in seconds from the activity's start: after start_time, and at most the activity's elapsed_time"),
  type: z.enum(["WORK", "RECOVERY"]).default("WORK").describe("WORK (default) or RECOVERY"),
  label: z.string().optional().describe("Label shown for the interval"),
});
type Interval = z.infer<typeof intervalSchema>;

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

const name = (iv: Interval, k: number) => `Interval ${k + 1}${iv.label ? ` "${iv.label}"` : ""}`;

// What can be checked before fetching anything. An interval may start where the previous one ends.
function orderErrors(intervals: Interval[]): string[] {
  const errors: string[] = [];
  intervals.forEach((iv, k) => {
    if (iv.end_time <= iv.start_time) errors.push(`${name(iv, k)} ends at ${iv.end_time} s, not after its start at ${iv.start_time} s`);
    const prev = intervals[k - 1];
    if (!prev) return;
    if (iv.start_time < prev.start_time) {
      errors.push(`${name(iv, k)} starts at ${iv.start_time} s, before interval ${k} (${prev.start_time} s): sort the intervals by start_time`);
    } else if (iv.start_time < prev.end_time) {
      errors.push(`${name(iv, k)} starts at ${iv.start_time} s, before interval ${k} ends (${prev.end_time} s): intervals may not overlap`);
    }
  });
  return errors;
}

async function timeStream(account: Account, id: string): Promise<number[]> {
  // The entry get_activity_streams makes for ["time"]
  const cacheKey = `streams:${id}:time`;
  let streams = account.cache.get<Json[]>(cacheKey);
  if (!streams) {
    streams = await account.client.getActivityStreams(id, ["time"]) as Json[];
    account.cache.set(cacheKey, streams, TTL.NEVER);
  }
  const time = streams.find(s => s.type === "time")?.data as number[] | undefined;
  if (!time?.length) throw new Error(`Activity ${id} has no time stream`);
  return time;
}

// The first sample at or after t, or the last one
const indexAt = (time: number[], t: number) => {
  const k = time.findIndex(s => s >= t);
  return k < 0 ? time.length - 1 : k;
};

export function registerIntervalTools(tools: Tools) {
  tools.add(
    "set_activity_intervals",
    `Replace an activity's intervals: the list given becomes its full set, and the intervals it has now are removed, not merged. (intervals.icu's PUT /activity/{id}/intervals replaces them with all=true, which this sends, and merges with all=false.) ` +
      `Times are seconds from the activity's start, as ${tools.name("get_activity")} shows its intervals' start_time and end_time. ` +
      "The intervals must be sorted by start_time, may not overlap (one may start where the previous one ends) and must end within the activity's elapsed time; otherwise nothing is written. " +
      "Only the intervals change (and what intervals.icu derives from them, such as interval groups), not the streams, laps, name, description or other fields. " +
      "Returns the activity's intervals as intervals.icu now has them.",
    {
      id: activityId.describe("Activity ID"),
      intervals: z.array(intervalSchema).min(1).describe("All of the activity's intervals, sorted by start_time"),
    },
    async ({ id, intervals }, account) => {
      const errors = orderErrors(intervals);
      if (errors.length) return fail(errors.join("\n"));

      // Also checks the activity is this athlete's: the intervals path has no athlete in it
      const [activity] = await getActivity(account, id);
      if (activity.source === "STRAVA") return fail(`Activity ${id} comes from Strava, and intervals.icu can't change Strava activities`);
      const elapsed = activity.elapsed_time;
      if (typeof elapsed !== "number") return fail(`Activity ${id} has no elapsed_time to check the intervals against`);
      const late = intervals.flatMap((iv, k) =>
        iv.end_time > elapsed ? [`${name(iv, k)} ends at ${iv.end_time} s, after the activity ends (elapsed_time ${elapsed} s)`] : []
      );
      if (late.length) return fail(late.join("\n"));

      // intervals.icu positions intervals by stream index, which its web app sends, and the
      // time stream has gaps where recording paused, so seconds aren't indexes
      const time = await timeStream(account, id);
      const body: Json[] = [];
      for (const [k, iv] of intervals.entries()) {
        const start_index = indexAt(time, iv.start_time), end_index = indexAt(time, iv.end_time);
        if (end_index <= start_index) {
          return fail(`${name(iv, k)} has no samples between ${iv.start_time} s and ${iv.end_time} s: recording was paused`);
        }
        body.push({
          start_index, end_index, start_time: iv.start_time, end_time: iv.end_time, type: iv.type,
          ...(iv.label != null && { label: iv.label }),
        });
      }

      const result = await account.client.updateIntervals(id, body) as Json;
      // get_activity's intervals, and the interval summaries in activity lists
      account.cache.delete(activityCacheKey(id));
      account.cache.deletePrefix("activities:");
      const out = Array.isArray(result?.icu_intervals)
        ? { id, icu_intervals: (result.icu_intervals as Json[]).map(withoutNulls) }
        : result;
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );
}
