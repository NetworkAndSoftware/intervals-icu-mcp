import { z } from "zod";
import { activityCacheKey, activityId, getActivity, type Tools } from "./accounts.js";
import { boundaryTime, getRide, resolve, windowSchema } from "./analysis.js";

type Json = Record<string, unknown>;

// Of an interval's ~80 fields, about half of them null, the ones these tools return
const INTERVAL_FIELDS = [
  "id", "type", "label", "start_index", "end_index", "start_time", "end_time", "elapsed_time", "moving_time",
  "distance", "average_watts", "max_watts", "weighted_average_watts", "average_heartrate", "max_heartrate",
  "average_cadence", "joules_above_ftp", "wbal_start", "wbal_end", "training_load", "zone", "average_gradient",
];

// Decimals kept of the fields that aren't whole numbers: intervals.icu sends up to ten
// (gradient -0.006331372, a fraction; cadence 80.32361)
const DECIMALS: Record<string, number> = { distance: 0, average_cadence: 0, training_load: 1, average_gradient: 3 };

const rounded = (k: string, v: unknown) =>
  typeof v === "number" && k in DECIMALS ? Math.round(v * 10 ** DECIMALS[k]) / 10 ** DECIMALS[k] : v;

const pickInterval = (interval: Json) =>
  Object.fromEntries(INTERVAL_FIELDS.filter(k => interval[k] != null).map(k => [k, rounded(k, interval[k])]));

const intervalSchema = windowSchema.extend({
  label: z.string().optional().describe("The interval's label"),
  type: z.enum(["WORK", "RECOVERY"]).optional().describe("WORK (default) or RECOVERY"),
});

export function registerIntervalTools(tools: Tools) {
  tools.add(
    "get_activity_intervals",
    "Intervals of an activity: for each, its start and end (start_time/end_time: seconds from the start; start_index/end_index: stream positions), distance, power, NP, HR, cadence, kJ above FTP, W′ balance, load and zone.",
    {
      id: activityId.describe("Activity ID"),
    },
    async ({ id }, account) => {
      const [activity] = await getActivity(account, id);
      const intervals = ((activity.icu_intervals ?? []) as Json[]).map(pickInterval);
      return { content: [{ type: "text", text: JSON.stringify(intervals) }] };
    }
  );

  tools.add(
    "set_activity_intervals",
    `Write intervals on an activity, each from a time, distance or place to another, as ${tools.name("analyze_activity_window")}'s windows; intervals.icu then works out their figures. With replace, they replace all the activity's intervals.`,
    {
      id: activityId.describe("Activity ID"),
      intervals: z.array(intervalSchema).min(1).describe("Each starts and ends at a time (start_s/end_s), distance (start_m/end_m) or place (start_point/end_point). They may not overlap"),
      replace: z.boolean().describe("true: the activity's intervals become exactly these; false: these are merged with the existing ones"),
    },
    async ({ id, intervals, replace }, account) => {
      // Also checks the activity is this athlete's: the intervals path has no athlete in it
      await getActivity(account, id);
      const ride = await getRide(account, id);

      // Placed on the streams first, so nothing is written unless every interval fits
      const errors: string[] = [];
      const placed = intervals.flatMap((w, i) => {
        const name = w.label ?? `interval ${i + 1}`;
        try {
          return [{ ...resolve(ride, w), w, name }];
        } catch (error) {
          errors.push(`${name}: ${(error as Error).message}`);
          return [];
        }
      });
      placed.sort((x, y) => x.a - y.a);
      for (let i = 1; i < placed.length; i++) {
        if (placed[i].a < placed[i - 1].b) errors.push(`${placed[i - 1].name} and ${placed[i].name} overlap`);
      }
      if (errors.length) {
        return { content: [{ type: "text", text: `Nothing written. ${errors.join("; ")}` }], isError: true };
      }

      // end_index is exclusive, like a window's end. intervals.icu works from the indexes; the
      // times are sent too, worked out from the same samples.
      const sent = placed.map(({ a, b, w }) => ({
        start_index: a,
        end_index: b,
        start_time: ride.time[a],
        end_time: boundaryTime(ride, b),
        type: w.type ?? "WORK",
        ...(w.label != null && { label: w.label }),
      }));
      const result = await account.client.updateIntervals(id, sent, replace) as Json;
      account.cache.delete(activityCacheKey(id));
      // The list carries each activity's interval_summary
      account.cache.deletePrefix("activities:");

      const written = (result.icu_intervals ?? []) as Json[];
      const missing = sent.filter(s => !written.some(r => r.start_index === s.start_index && r.end_index === s.end_index));
      const data = {
        intervals: written.map(pickInterval),
        ...(missing.length && {
          warning: `intervals.icu's answer lacks ${missing.length} of the ${sent.length} intervals sent: ${JSON.stringify(missing)}`,
        }),
      };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
  );
}
