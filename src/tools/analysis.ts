import { z } from "zod";
import { TTL } from "../cache.js";
import type { StreamType } from "../types.js";
import { activityId, getActivity, type Account, type Tools } from "./accounts.js";

type Json = Record<string, unknown>;

// Sorted, so the cache entry is the one get_activity_streams makes for the same types
const STREAMS: StreamType[] = ["distance", "heartrate", "latlng", "time", "watts"];
const MATCH_RADIUS_M = 30;
// A longer gap between samples is a stop (auto-pause): no riding, and 0 W for W′ balance
const MAX_SAMPLE_S = 5;
const WBAL_MODEL = "Skiba differential (Skiba et al. 2015), from the ride start; stops count as 0 W";

export type Ride = {
  n: number;
  time: number[];
  // Seconds each sample's power lasts, and seconds stopped after it
  moving: number[];
  stopped: number[];
  watts: number[];
  hr: (number | null)[] | null;
  distance: number[] | null;
  lat: (number | null)[] | null;
  lng: (number | null)[] | null;
};

const point = z.array(z.number()).length(2);
export const windowSchema = z.object({
  label: z.string().optional().describe("Name shown with the results"),
  start_s: z.number().optional().describe("Start, seconds from the ride start (elapsed, like interval start_time)"),
  end_s: z.number().optional().describe("End, seconds from the ride start"),
  start_m: z.number().optional().describe("Start, meters from the ride start"),
  end_m: z.number().optional().describe("End, meters from the ride start"),
  start_point: point.optional().describe(`Start: [lat, lng], at the first pass within ${MATCH_RADIUS_M} m`),
  end_point: point.optional().describe(`End: [lat, lng], at the next pass within ${MATCH_RADIUS_M} m after the start`),
  after_s: z.number().optional().describe("Match start_point only after this many seconds"),
});
export type Window = z.infer<typeof windowSchema>;

export async function getRide(account: Account, id: string): Promise<Ride> {
  const cacheKey = `streams:${id}:${STREAMS.join(",")}`;
  let streams = account.cache.get<Json[]>(cacheKey);
  if (!streams) {
    streams = await account.client.getActivityStreams(id, STREAMS) as Json[];
    account.cache.set(cacheKey, streams, TTL.NEVER);
  }
  const stream = (type: string) => streams!.find(s => s.type === type);
  const data = (type: string) => stream(type)?.data as (number | null)[] | undefined;

  const time = data("time"), watts = data("watts");
  if (!time?.length) throw new Error(`Activity ${id} has no time stream`);
  if (!watts?.length) throw new Error(`Activity ${id} has no power data`);
  const n = time.length;
  const moving: number[] = [], stopped: number[] = [];
  for (let k = 0; k < n; k++) {
    const dt = k < n - 1 ? time[k + 1]! - time[k]! : 1;
    moving.push(!(dt > 0) ? 0 : dt > MAX_SAMPLE_S ? 1 : dt);
    stopped.push(dt > MAX_SAMPLE_S ? dt - 1 : 0);
  }
  // The latlng stream holds latitudes in data and longitudes in data2
  const latlng = stream("latlng");
  return {
    n,
    time: time as number[],
    moving,
    stopped,
    watts: watts.map(w => w ?? 0),
    hr: data("heartrate") ?? null,
    distance: data("distance") as number[] | undefined ?? null,
    lat: latlng?.data2 ? latlng.data as (number | null)[] : null,
    lng: latlng?.data2 ? latlng.data2 as (number | null)[] : null,
  };
}

function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

// The sample closest to the point in the first pass within MATCH_RADIUS_M from sample `from`
// on, skipping a pass already under way at `from` when asked (a loop's end at its start)
function findPass(ride: Ride, [lat, lng]: number[], from: number, skipCurrent: boolean) {
  if (!ride.lat || !ride.lng) throw new Error("The activity has no GPS data");
  const near = (k: number) => {
    const la = ride.lat![k], ln = ride.lng![k];
    if (la == null || ln == null) return null;
    const d = metersBetween(lat, lng, la, ln);
    return d <= MATCH_RADIUS_M ? d : null;
  };
  let k = from;
  if (skipCurrent) while (k < ride.n && near(k) != null) k++;
  while (k < ride.n && near(k) == null) k++;
  if (k >= ride.n) return null;
  let index = k, offset = near(k)!;
  for (k++; k < ride.n; k++) {
    const d = near(k);
    if (d == null) break;
    if (d < offset) [index, offset] = [k, d];
  }
  return { index, offset };
}

const firstIndex = (values: number[], test: (v: number) => boolean) => {
  const k = values.findIndex(test);
  return k < 0 ? null : k;
};

// The window as samples a..b-1: sample b (or the ride's end) is where it ends
export function resolve(ride: Ride, w: Window) {
  const forms = (...values: unknown[]) => values.filter(v => v != null).length;
  if (forms(w.start_s, w.start_m, w.start_point) !== 1) throw new Error("Give exactly one of start_s, start_m, start_point");
  if (forms(w.end_s, w.end_m, w.end_point) !== 1) throw new Error("Give exactly one of end_s, end_m, end_point");
  const distance = () => {
    if (!ride.distance) throw new Error("The activity has no distance stream");
    return ride.distance;
  };

  let a: number | null, startMatch: number | undefined;
  if (w.start_s != null) {
    a = firstIndex(ride.time, t => t >= w.start_s!);
  } else if (w.start_m != null) {
    a = firstIndex(distance(), d => d >= w.start_m!);
  } else {
    const from = firstIndex(ride.time, t => t >= (w.after_s ?? 0));
    const pass = from == null ? null : findPass(ride, w.start_point!, from, false);
    if (!pass) throw new Error(`No pass within ${MATCH_RADIUS_M} m of start_point${w.after_s ? ` after ${w.after_s} s` : ""}`);
    [a, startMatch] = [pass.index, pass.offset];
  }
  if (a == null) throw new Error("The ride ends before the window starts");

  let b: number, endMatch: number | undefined;
  if (w.end_s != null) {
    b = firstIndex(ride.time, t => t >= w.end_s!) ?? ride.n;
  } else if (w.end_m != null) {
    b = firstIndex(distance(), d => d >= w.end_m!) ?? ride.n;
  } else {
    const pass = findPass(ride, w.end_point!, a, true);
    if (!pass) throw new Error(`No pass within ${MATCH_RADIUS_M} m of end_point after the start`);
    [b, endMatch] = [pass.index, pass.offset];
  }
  if (b <= a) throw new Error("The window ends before it starts");
  return { a, b, startMatch, endMatch };
}

// The time of the boundary before sample k, as a window's end: sample k's own, or the ride's end
export const boundaryTime = (ride: Ride, k: number) =>
  k < ride.n ? ride.time[k] : ride.time[ride.n - 1] + ride.moving[ride.n - 1];

// Normalized power: 30 s rolling average, 4th power mean, 4th root (null under 30 s)
function normalizedPower(ride: Ride, a: number, b: number): number | null {
  const seconds: number[] = [];
  for (let k = a; k < b; k++) for (let s = 0; s < Math.round(ride.moving[k]); s++) seconds.push(ride.watts[k]);
  if (seconds.length < 30) return null;
  let sum = 0, total = 0, count = 0;
  for (let i = 0; i < seconds.length; i++) {
    sum += seconds[i] - (i >= 30 ? seconds[i - 30] : 0);
    if (i >= 29) {
      total += (sum / 30) ** 4;
      count++;
    }
  }
  return (total / count) ** 0.25;
}

export function registerAnalysisTools(tools: Tools) {
  tools.add(
    "analyze_activity_window",
    "Numbers for sections of a ride, computed from its streams without returning them: per window, time, distance, duration, avg power, NP, avg/max HR, kJ above threshold_w and above CP, W′ balance at its start, end and lowest (Skiba differential model, from the ride start), and the ride's kJ above threshold_w before it.",
    {
      id: activityId.describe("Activity ID"),
      cp: z.number().positive().describe("Critical power, W"),
      w_prime: z.number().positive().describe("W′, J"),
      threshold_w: z.number().positive().optional().describe("Power for the kJ-above-threshold figures, W. Default: the activity's FTP"),
      windows: z.array(windowSchema).min(1).describe("Each starts and ends at a time (start_s/end_s), distance (start_m/end_m) or place (start_point/end_point)"),
    },
    async ({ id, cp, w_prime, threshold_w, windows }, account) => {
      // Also checks the activity is this athlete's: the streams path has no athlete in it
      const [activity] = await getActivity(account, id);
      const threshold = threshold_w ?? activity.icu_ftp as number | undefined;
      if (!threshold) {
        return { content: [{ type: "text", text: "The activity has no FTP: pass threshold_w" }], isError: true };
      }
      const ride = await getRide(account, id);
      const { n, moving, stopped, watts } = ride;

      // W′ balance at each sample's start (wbal[n]: the ride's end), and after its riding,
      // before any stop that follows it: the lowest point of each sample is one of the two
      const wbal = [w_prime], ridden: number[] = [];
      // kJ above the threshold before each sample, in J
      const above = [0];
      for (let k = 0; k < n; k++) {
        const p = watts[k];
        let w = wbal[k];
        w = p > cp ? w - (p - cp) * moving[k] : w_prime - (w_prime - w) * Math.exp(-(cp - p) * moving[k] / w_prime);
        ridden.push(w);
        if (stopped[k]) w = w_prime - (w_prime - w) * Math.exp(-cp * stopped[k] / w_prime);
        wbal.push(w);
        above.push(above[k] + Math.max(0, p - threshold) * moving[k]);
      }

      const round = (v: number | null | undefined, digits = 0) => v == null ? undefined : Math.round(v * 10 ** digits) / 10 ** digits;
      const results = windows.map(w => {
        try {
          const { a, b, startMatch, endMatch } = resolve(ride, w);
          let seconds = 0, work = 0, aboveCp = 0, hrSeconds = 0, hrSum = 0, maxHr: number | undefined;
          let lowest = wbal[a];
          for (let k = a; k < b; k++) {
            seconds += moving[k];
            work += watts[k] * moving[k];
            aboveCp += Math.max(0, watts[k] - cp) * moving[k];
            const hr = ride.hr?.[k];
            if (hr) {
              hrSeconds += moving[k];
              hrSum += hr * moving[k];
              maxHr = Math.max(maxHr ?? 0, hr);
            }
            lowest = Math.min(lowest, ridden[k]);
          }
          const startTime = ride.time[a];
          const endTime = boundaryTime(ride, b);
          const startDistance = ride.distance?.[a];
          const endDistance = ride.distance?.[Math.min(b, n - 1)];
          return withoutUndefined({
            label: w.label,
            start_time_s: startTime,
            end_time_s: endTime,
            duration_s: endTime - startTime,
            start_distance_m: round(startDistance),
            end_distance_m: round(endDistance),
            distance_m: startDistance == null || endDistance == null ? undefined : round(endDistance - startDistance),
            start_match_m: round(startMatch, 1),
            end_match_m: round(endMatch, 1),
            avg_power_w: seconds ? round(work / seconds) : undefined,
            np_w: round(normalizedPower(ride, a, b)),
            avg_hr: hrSeconds ? round(hrSum / hrSeconds) : undefined,
            max_hr: maxHr,
            kj_above_threshold: round((above[b] - above[a]) / 1000, 1),
            kj_above_cp: round(aboveCp / 1000, 1),
            wbal_start_j: round(wbal[a]),
            wbal_end_j: round(wbal[b]),
            wbal_min_j: round(lowest),
            ride_kj_above_threshold_before: round(above[a] / 1000, 1),
          });
        } catch (error) {
          return withoutUndefined({ label: w.label, error: (error as Error).message });
        }
      });

      const data = {
        activity: { id: activity.id, name: activity.name, start_date_local: activity.start_date_local },
        cp_w: cp,
        w_prime_j: w_prime,
        threshold_w: threshold,
        threshold_source: threshold_w == null ? "activity FTP" : "threshold_w",
        wbal_model: WBAL_MODEL,
        windows: results,
      };
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}

const withoutUndefined = (record: Json) => Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined));
