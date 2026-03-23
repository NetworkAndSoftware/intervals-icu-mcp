import { z } from "zod";
import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function r1(n: number | null | undefined): number | undefined {
  if (n == null) return undefined;
  return Math.round(n * 10) / 10;
}

function getMonday(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null && v !== "" && v !== 0 && v !== false) out[k] = v;
  }
  return out;
}

function compactActivity(a: any): Record<string, unknown> {
  return stripNulls({
    name: a.name,
    type: a.type,
    tss: r1(a.icu_training_load),
    time_mins: a.icu_recording_time ? Math.round(a.icu_recording_time / 60) : undefined,
    np: a.icu_weighted_avg_watts ? Math.round(a.icu_weighted_avg_watts) : undefined,
    avg_power: a.icu_average_watts ? Math.round(a.icu_average_watts) : undefined,
    avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : undefined,
    max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : undefined,
    intervals: a.interval_summary
      ? (Array.isArray(a.interval_summary) ? a.interval_summary.join("; ") : a.interval_summary)
      : undefined,
  });
}

function compactWellness(w: any): Record<string, unknown> | undefined {
  const out = stripNulls({
    resting_hr: w.restingHR,
    hrv: r1(w.hrv),
    sleep_hrs: w.sleepSecs ? Math.round(w.sleepSecs / 3600 * 10) / 10 : undefined,
    spO2: w.spO2,
    soreness: w.soreness,
    fatigue: w.fatigue,
    stress: w.stress,
    mood: w.mood,
    motivation: w.motivation,
    weight: r1(w.weight),
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

function compactPlannedWorkout(e: any): Record<string, unknown> {
  return stripNulls({
    name: e.name,
    type: e.type,
    category: e.category && e.category.startsWith("RACE") ? e.category : undefined,
    tss: r1(e.icu_training_load),
    time_mins: e.moving_time ? Math.round(e.moving_time / 60) : undefined,
  });
}

function buildSeasonEntry(f: any, weekNum: number, targets: any[] | undefined): Record<string, unknown> {
  // Load by sport from byCategory
  const load: Record<string, unknown> = {};
  if (f.byCategory) {
    for (const cat of f.byCategory) {
      if (cat.training_load && cat.category) {
        load[cat.category] = stripNulls({
          tss: Math.round(cat.training_load),
          hrs: r1(cat.time ? cat.time / 3600 : 0),
          count: cat.count,
        });
      }
    }
  }

  // Planned from TARGET events
  let planned: Record<string, number> | undefined;
  if (targets && targets.length > 0) {
    planned = {};
    for (const t of targets) {
      if (t.load_target && t.type) planned[t.type] = r1(t.load_target)!;
    }
    if (Object.keys(planned).length === 0) planned = undefined;
  }

  // Zone times in minutes
  let zones_mins: number[] | undefined;
  if (f.timeInZones && Array.isArray(f.timeInZones)) {
    zones_mins = f.timeInZones.map((s: number) => Math.round(s / 60));
    if (zones_mins!.every((m: number) => m === 0)) zones_mins = undefined;
  }

  const entry: Record<string, unknown> = {
    week: f.date,
    week_num: weekNum,
  };

  const ctl = r1(f.fitness);
  const atl = r1(f.fatigue);
  const tsb = r1(f.form);
  const ramp = r1(f.rampRate);
  if (ctl) entry.ctl = ctl;
  if (atl) entry.atl = atl;
  if (tsb) entry.tsb = tsb;
  if (ramp) entry.ramp = ramp;
  if (Object.keys(load).length > 0) entry.load = load;
  if (planned) entry.planned = planned;
  if (zones_mins) entry.zones_mins = zones_mins;
  if (f.total_elevation_gain) entry.elevation_m = Math.round(f.total_elevation_gain);
  if (f.calories) entry.calories = Math.round(f.calories);

  return entry;
}

export function registerCoachingTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_coaching_context",
    "Get a compact coaching context snapshot including current fitness/fatigue, this week's planned vs actual training, daily wellness trends, and activity summaries. Designed for LLM coaching conversations. Returns one week by default; use weeks_back for trend analysis. Use season_start for full-season weekly progression including zone distribution.",
    {
      date: z.string().optional().describe("Reference date (ISO format, e.g. 2026-03-18). Defaults to today."),
      weeks_back: z.number().int().min(0).max(4).optional().describe("Number of prior completed weeks to include in detailed view (0-4). Default 0 = current week only."),
      season_start: z.string().optional().describe("Start date for season summary (ISO format, e.g. 2026-01-05). When provided, includes a 'season' array with compact weekly summaries showing CTL/ATL/TSB progression, load by sport, and zone distribution. Use a Monday for clean alignment."),
    },
    async ({ date, weeks_back, season_start }) => {
      const refDate = date || new Date().toISOString().slice(0, 10);
      const weeksBack = weeks_back || 0;

      const currentMonday = getMonday(refDate);
      const earliestMonday = addDays(currentMonday, -7 * weeksBack);
      const currentSunday = addDays(currentMonday, 6);

      // Determine the overall earliest date needed (for season or weeks_back)
      const seasonMonday = season_start ? getMonday(season_start) : null;
      const overallEarliest = seasonMonday && seasonMonday < earliestMonday ? seasonMonday : earliestMonday;

      // Build parallel fetches
      const fetches: Promise<any>[] = [
        fetchCached(cache, `fitness:${overallEarliest}:${currentSunday}`, TTL.FOUR_HOURS,
          () => client.getFitness(overallEarliest, currentSunday)),
        fetchCached(cache, `activities:${earliestMonday}:${currentSunday}`, TTL.ONE_HOUR,
          () => client.getActivities(earliestMonday, currentSunday)),
        fetchCached(cache, `wellness:${earliestMonday}:${currentSunday}`, TTL.ONE_HOUR,
          () => client.getWellness(earliestMonday, currentSunday)),
      ];

      // Events: need current week range for detailed view, plus season range for TARGET events
      const eventsOldest = seasonMonday && seasonMonday < earliestMonday ? seasonMonday : earliestMonday;
      fetches.push(
        fetchCached(cache, `events:${eventsOldest}:${currentSunday}`, TTL.ONE_HOUR,
          () => client.getEvents(eventsOldest, currentSunday))
      );

      const [fitnessData, activitiesData, wellnessData, eventsData] = await Promise.all(fetches);

      const fitness = fitnessData as any[];
      const activities = activitiesData as any[];
      const wellness = wellnessData as any[];
      const events = eventsData as any[];

      // Index data by date
      const wellnessByDate = new Map<string, any>();
      for (const w of wellness) {
        wellnessByDate.set(w.id, w);
      }

      const activitiesByDate = new Map<string, any[]>();
      for (const a of activities) {
        const d = (a.start_date_local || "").slice(0, 10);
        if (!activitiesByDate.has(d)) activitiesByDate.set(d, []);
        activitiesByDate.get(d)!.push(a);
      }

      const workoutsByDate = new Map<string, any[]>();
      const targetsByWeek = new Map<string, any[]>();
      for (const e of events) {
        const d = (e.start_date_local || "").slice(0, 10);
        if (e.category === "WORKOUT" || (e.category && e.category.startsWith("RACE"))) {
          if (!workoutsByDate.has(d)) workoutsByDate.set(d, []);
          workoutsByDate.get(d)!.push(e);
        } else if (e.category === "TARGET") {
          const mon = getMonday(d);
          if (!targetsByWeek.has(mon)) targetsByWeek.set(mon, []);
          targetsByWeek.get(mon)!.push(e);
        }
      }

      // Find current snapshot from fitness data (uses "date" field)
      // Fitness API returns newest-first, so first entry <= refDate is the most recent
      const latestFitness = fitness.find((f: any) => f.date && f.date <= refDate) || null;

      // Find latest weight from wellness
      const latestWeight = [...wellnessByDate.values()]
        .filter(w => w.weight && w.id <= refDate)
        .sort((a, b) => a.id.localeCompare(b.id))
        .pop()?.weight;

      // Extract eFTP per category from byCategory array
      const eftpByType: Record<string, number> = {};
      if (latestFitness?.byCategory) {
        for (const cat of latestFitness.byCategory) {
          if (cat.eftp && cat.category) eftpByType[cat.category] = Math.round(cat.eftp);
        }
      }

      // Build snapshot
      const snapshot: Record<string, unknown> = stripNulls({
        date: refDate,
        ctl: r1(latestFitness?.fitness),
        atl: r1(latestFitness?.fatigue),
        tsb: r1(latestFitness?.form),
        ramp_rate: r1(latestFitness?.rampRate),
        eftp: Object.keys(eftpByType).length > 0 ? eftpByType : undefined,
        weight: r1(latestWeight || latestFitness?.weight),
      });

      // Build detailed weeks
      const weeks: Record<string, unknown>[] = [];
      for (let w = 0; w <= weeksBack; w++) {
        const weekMonday = addDays(currentMonday, -7 * w);
        const weekSunday = addDays(weekMonday, 6);
        const label = w === 0 ? "current" : `week_-${w}`;
        const isCurrent = w === 0;

        // Weekly targets
        const targets = targetsByWeek.get(weekMonday) || [];
        const planned: Record<string, number> = {};
        let weekDescription: string | undefined;
        for (const t of targets) {
          if (t.load_target && t.type) planned[t.type] = r1(t.load_target)!;
          if (t.description && !weekDescription) weekDescription = t.description;
        }

        // Weekly actuals
        const actual: Record<string, { tss: number; time_hrs: number; count: number }> = {};
        for (let d = 0; d < 7; d++) {
          const dayDate = addDays(weekMonday, d);
          const dayActivities = activitiesByDate.get(dayDate) || [];
          for (const a of dayActivities) {
            const type = a.type || "Unknown";
            if (!actual[type]) actual[type] = { tss: 0, time_hrs: 0, count: 0 };
            actual[type].tss += a.icu_training_load || 0;
            actual[type].time_hrs += (a.icu_recording_time || 0) / 3600;
            actual[type].count++;
          }
        }
        // Round actuals
        const actualRounded: Record<string, unknown> = {};
        for (const [type, v] of Object.entries(actual)) {
          actualRounded[type] = { tss: r1(v.tss), time_hrs: r1(v.time_hrs), count: v.count };
        }

        // Week-end fitness (uses "date" field; API returns newest-first, so first match is latest in week)
        const weekEndFitness = fitness.find((f: any) =>
          f.date && f.date >= weekMonday && f.date <= weekSunday
        ) || null;

        // Days
        const days: Record<string, unknown>[] = [];
        for (let d = 0; d < 7; d++) {
          const dayDate = addDays(weekMonday, d);
          const dayOfWeek = DAY_NAMES[new Date(dayDate + "T00:00:00").getDay()];

          const dayObj: Record<string, unknown> = { date: dayDate, day: dayOfWeek };

          const wl = wellnessByDate.get(dayDate);
          if (wl) {
            const cw = compactWellness(wl);
            if (cw) dayObj.wellness = cw;
          }

          const dayActivities = activitiesByDate.get(dayDate) || [];
          dayObj.activities = dayActivities.map(compactActivity);

          if (isCurrent) {
            const dayWorkouts = workoutsByDate.get(dayDate) || [];
            dayObj.planned = dayWorkouts.map(compactPlannedWorkout);
          }

          days.push(dayObj);
        }

        const week: Record<string, unknown> = {
          start: weekMonday,
          end: weekSunday,
          label,
        };
        if (weekDescription) week.description = weekDescription;
        if (Object.keys(planned).length > 0) week.planned = planned;
        if (Object.keys(actualRounded).length > 0) week.actual = actualRounded;
        if (weekEndFitness) {
          week.ctl = r1(weekEndFitness.fitness);
          week.atl = r1(weekEndFitness.fatigue);
          week.tsb = r1(weekEndFitness.form);
        }
        week.days = days;

        weeks.push(week);
      }

      snapshot.weeks = weeks;

      // Build season summary if season_start provided
      if (season_start) {
        const seasonMon = getMonday(season_start);
        // Fitness API returns newest-first; reverse to get oldest-first for season progression
        const seasonFitness = fitness
          .filter((f: any) => f.date && f.date >= seasonMon)
          .reverse();
        const season: Record<string, unknown>[] = [];
        let weekNum = 1;

        for (const f of seasonFitness) {
          const weekTargets = targetsByWeek.get(f.date);
          season.push(buildSeasonEntry(f, weekNum, weekTargets));
          weekNum++;
        }

        snapshot.season = season;
      }

      return { content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }] };
    }
  );
}

async function fetchCached<T>(cache: Cache, key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  const cached = cache.get<T>(key);
  if (cached) return cached;
  const data = await fetcher();
  cache.set(key, data, ttl);
  return data;
}
