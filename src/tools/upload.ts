import { z } from "zod";
import { readFile } from "fs/promises";
import type { IntervalsClient } from "../api.js";
import type { Cache } from "../cache.js";
import { addDays, dayOfWeek, daysBetween } from "../dates.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// intervals.icu rejects unknown categories (e.g. "RACE", "REST_DAY") with a bare "JSON parse error"
const CATEGORIES = [
  "WORKOUT", "RACE_A", "RACE_B", "RACE_C", "NOTE", "TARGET", "HOLIDAY", "SICK", "INJURED",
  "SEASON_START", "SET_EFTP", "SET_FITNESS", "FITNESS_DAYS",
] as const;

// Fields create_event and update_event share, named as the API (and get_events) names them.
// Updates are partial: fields left out keep their value, "" clears a text field, [] clears tags.
const eventFields = {
  name: z.string().optional().describe("Event name"),
  description: z.string().optional().describe("Notes. For a WORKOUT this is also the workout itself, in intervals.icu's workout text: one step per line ('- 15m 55%', '- 5m 95-105% 90rpm'), with 'Nx' on its own line before steps to repeat them. intervals.icu rebuilds the structure, duration and load from it; other lines stay as notes"),
  type: z.string().optional().describe('Activity type, e.g. "Ride", "VirtualRide", "Run", "Rowing". Required for workouts, races and SET_EFTP'),
  start_time: z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/).optional().describe('Local start time, HH:MM (e.g. "07:30"), or "" for all day. Only workouts and races keep a time'),
  end_date: z.string().optional().describe("Last day (inclusive) of a multi-day event such as a holiday, sick or injured period (ISO format)"),
  load_target: z.number().optional().describe("Planned training load (TSS)"),
  time_target: z.number().optional().describe("Planned duration in seconds"),
  distance_target: z.number().optional().describe("Planned distance in meters"),
  indoor: z.boolean().optional().describe("Indoor (true) or outdoor (false)"),
  color: z.string().optional().describe("Calendar color, e.g. 'red' or '#ff0000'"),
  tags: z.array(z.string()).optional().describe("Tags (replace the existing ones)"),
  entered: z.boolean().optional().describe("Races: whether the athlete has entered (signed up for) it"),
  sub_type: z.enum(["NONE", "COMMUTE", "WARMUP", "COOLDOWN", "RACE"]).optional().describe("Workouts only: sub type"),
  target: z.enum(["AUTO", "POWER", "HR", "PACE"]).optional().describe("Workouts: what the steps target on a Garmin device"),
  carbs_per_hour: z.number().int().optional().describe("Workouts: planned carbohydrate intake, g/h"),
  for_week: z.boolean().optional().describe("Notes: show the note for the whole week"),
  show_on_ctl_line: z.boolean().optional().describe("Show on the fitness line of the fitness chart (races, notes, days off)"),
  show_as_note: z.boolean().optional().describe("Show as a note on the fitness chart"),
  not_on_fitness_chart: z.boolean().optional().describe("Leave off the fitness chart"),
  training_availability: z.enum(["NORMAL", "LIMITED", "UNAVAILABLE"]).optional().describe("HOLIDAY, SICK, INJURED: how much training is possible"),
  max_training_time: z.number().int().optional().describe("Days off with LIMITED availability: most training time per day, in seconds"),
  can_train_sports: z.array(z.string()).optional().describe('Days off with LIMITED availability: sports still possible, e.g. ["Ride", "Rowing"]'),
  icu_ftp: z.number().int().optional().describe("SET_EFTP: FTP in watts from this date"),
  w_prime: z.number().int().optional().describe("SET_EFTP: W′ in joules"),
  p_max: z.number().int().optional().describe("SET_EFTP: Pmax in watts"),
  icu_ctl: z.number().optional().describe("SET_FITNESS: fitness (CTL) on this date"),
  icu_atl: z.number().optional().describe("SET_FITNESS: fatigue (ATL) on this date"),
  ctl_days: z.number().int().optional().describe("FITNESS_DAYS: fitness (CTL) time constant in days (default 42)"),
  atl_days: z.number().int().optional().describe("FITNESS_DAYS: fatigue (ATL) time constant in days (default 7)"),
  file_path: z.string().optional().describe("Absolute path to a workout file (.zwo, .mrc, .erg, .fit) to use as the workout; its name and steps replace the event's name and description"),
};

// The calendar shows icu_training_load, moving_time and distance rather than the *_target
// fields the API takes, so set both
function eventBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v != null) body[k] = v;
  }
  if (body.load_target != null) body.icu_training_load = body.load_target;
  if (body.time_target != null) body.moving_time = body.time_target;
  if (body.distance_target != null) body.distance = body.distance_target;
  return body;
}

// end_date_local is exclusive: a one-day event ends at midnight the next day
const endDateLocal = (lastDay: string) => `${addDays(lastDay, 1)}T00:00:00`;

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

async function readWorkoutFile(file_path: string) {
  const fileBuffer = await readFile(file_path);
  return {
    filename: file_path.replace(/\\/g, "/").split("/").pop() || "workout.fit",
    file_contents_base64: fileBuffer.toString("base64"),
  };
}

export function registerUploadTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache,
  // Off when hosted remotely: there's no user disk there, and reading the host's
  // filesystem (e.g. /proc/self/environ) would leak its credentials
  { allowLocalFiles = true }: { allowLocalFiles?: boolean } = {}
) {
  // Writes must drop what they make stale, or reads keep serving the old data for up to
  // the TTL (forever, for a single activity). SET_FITNESS, SET_EFTP and FITNESS_DAYS
  // events change the fitness numbers too.
  const eventsChanged = () => {
    for (const prefix of ["events:", "fitness:"]) cache.deletePrefix(prefix);
  };
  const activitiesChanged = (id?: string) => {
    for (const prefix of ["activities:", "fitness:", "power_curve:"]) cache.deletePrefix(prefix);
    if (id) {
      cache.delete(`activity:${id}`);
      cache.deletePrefix(`streams:${id}:`);
    }
  };

  if (allowLocalFiles) server.tool(
    "upload_activity",
    "Upload a completed activity file (.fit, .gpx, .tcx, .fit.gz) to intervals.icu.",
    {
      file_path: z.string().describe("Absolute path to the activity file on disk"),
      name: z.string().optional().describe("Optional activity name"),
      description: z.string().optional().describe("Optional activity description"),
    },
    async ({ file_path, name, description }) => {
      const fileBuffer = await readFile(file_path);
      const filename = file_path.replace(/\\/g, "/").split("/").pop() || "activity.fit";
      const result = await client.uploadActivity(fileBuffer, filename, name, description);
      activitiesChanged();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  const noLocalFiles = fail("file_path is not supported on the remote server");

  server.tool(
    "create_event",
    "Create an event on the intervals.icu calendar: a planned workout, race (A/B/C priority), note, weekly target, day off (holiday, sick, injured), season start, or a change to the fitness model (SET_EFTP, SET_FITNESS, FITNESS_DAYS).",
    {
      start_date: z.string().describe("Date for the event (ISO format, e.g. 2024-01-15)"),
      category: z.enum(CATEGORIES).describe("Event category. Races carry their priority: RACE_A (goal race), RACE_B, RACE_C. HOLIDAY, SICK and INJURED mark days off training"),
      ...eventFields,
      name: z.string().describe("Event name"),
      type: eventFields.type.describe('Activity type, e.g. "Ride", "VirtualRide", "Run", "Rowing". Defaults to "Ride"'),
    },
    async ({ start_date, category, start_time, end_date, file_path, ...fields }) => {
      if (file_path && !allowLocalFiles) return noLocalFiles;
      if (end_date && end_date < start_date) return fail(`end_date ${end_date} is before start_date ${start_date}`);

      const event: Record<string, unknown> = {
        ...eventBody(fields),
        category,
        start_date_local: `${start_date}T${start_time || "00:00"}:00`,
      };
      event.type ??= "Ride";
      if (end_date) event.end_date_local = endDateLocal(end_date);
      if (file_path) Object.assign(event, await readWorkoutFile(file_path));

      const result = await client.createEvent(event);
      eventsChanged();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "update_event",
    "Update an existing event on the intervals.icu calendar (workout, race, note, target, day off, ...): move it to another date or time, change its category, structure or any other field. Only the fields you pass change; \"\" clears a text field and [] clears tags.",
    {
      id: z.number().describe("The event ID to update (numeric, from get_events)"),
      start_date: z.string().optional().describe("Move the event to this date (ISO format). Keeps its start time and, for a multi-day event, its length"),
      category: z.enum(CATEGORIES).optional().describe("New category, e.g. RACE_B → RACE_A, or NOTE → WORKOUT (needs type). TARGET, SEASON_START, SET_EFTP, SET_FITNESS and FITNESS_DAYS events can't change category"),
      ...eventFields,
      remove_attachments: z.array(z.string()).optional().describe("IDs or filenames of attachments to remove. Attachments can only be added in the intervals.icu web app"),
    },
    async ({ id, start_date, start_time, end_date, category, file_path, remove_attachments, ...fields }) => {
      if (file_path && !allowLocalFiles) return noLocalFiles;

      const update = eventBody(fields);
      if (category) update.category = category;

      // Moving an event and removing attachments both start from what's there now
      if (start_date != null || start_time != null || end_date != null || remove_attachments?.length) {
        const current = await client.getEvent(id) as Record<string, unknown>;
        const [currentDate, currentTime] = String(current.start_date_local).split("T");
        const date = start_date ?? currentDate;

        // A date alone would reset the time to midnight
        if (start_date != null || start_time != null) {
          const time = start_time == null ? currentTime : start_time ? `${start_time}:00` : "00:00:00";
          update.start_date_local = `${date}T${time}`;
        }

        if (end_date != null) {
          if (end_date < date) return fail(`end_date ${end_date} is before the start date ${date}`);
          update.end_date_local = endDateLocal(end_date);
        } else if (start_date != null && current.end_date_local) {
          // intervals.icu moves a one-day event's end along with its start, but not a multi-day one's
          const span = daysBetween(currentDate, String(current.end_date_local).slice(0, 10));
          if (span > 1) update.end_date_local = endDateLocal(addDays(date, span - 1));
        }

        if (remove_attachments?.length) {
          // The API takes the attachments to keep, each as the full object it returned
          const attachments = (current.attachments ?? []) as { id: string; filename: string }[];
          const keep = attachments.filter(a => !remove_attachments.includes(a.id) && !remove_attachments.includes(a.filename));
          if (keep.length === attachments.length) {
            const list = attachments.map(a => `${a.filename} (${a.id})`).join(", ");
            return fail(`No attachment matches ${remove_attachments.join(", ")}. The event has ${list || "no attachments"}`);
          }
          update.attachments = keep;
        }
      }

      if (file_path) Object.assign(update, await readWorkoutFile(file_path));
      if (!Object.keys(update).length) return fail("Nothing to update: pass at least one field to change");

      const result = await client.updateEvent(id, update);
      eventsChanged();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "set_weekly_target",
    "Set the weekly training target (load/duration/distance) for a given week in intervals.icu. The target appears at the top of the week in the calendar. If a target already exists for that week and activity type, it will be updated; otherwise a new one is created.",
    {
      week_start: z.string().describe("Monday date of the target week (ISO format, e.g. 2026-03-16). Must be a Monday."),
      type: z.string().describe('Activity type (e.g. "Ride", "Run", "Rowing")'),
      load_target: z.number().optional().describe("Weekly planned training load (TSS)"),
      time_target: z.number().optional().describe("Weekly planned duration in seconds"),
      distance_target: z.number().optional().describe("Weekly planned distance in meters"),
      description: z.string().optional().describe("Optional note for the week"),
    },
    async ({ week_start, type, load_target, time_target, distance_target, description }) => {
      if (dayOfWeek(week_start) !== 1) {
        return { content: [{ type: "text", text: `${week_start} is not a Monday` }], isError: true };
      }

      // Check if a TARGET event already exists for this week and type
      const endStr = addDays(week_start, 7);
      const events = await client.getEvents(week_start, endStr) as Array<Record<string, unknown>>;
      const existing = events.find(
        e => e.category === "TARGET" && e.type === type && (e.start_date_local as string).startsWith(week_start)
      );

      if (existing) {
        const update: Record<string, unknown> = {};
        if (load_target != null) update.load_target = load_target;
        if (time_target != null) update.time_target = time_target;
        if (distance_target != null) update.distance_target = distance_target;
        if (description) update.description = description;
        const result = await client.updateEvent(existing.id as number, update);
        eventsChanged();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } else {
        const event: Record<string, unknown> = {
          category: "TARGET",
          start_date_local: `${week_start}T00:00:00`,
          name: "Weekly",
          type,
        };
        if (load_target != null) event.load_target = load_target;
        if (time_target != null) event.time_target = time_target;
        if (distance_target != null) event.distance_target = distance_target;
        if (description) event.description = description;
        const result = await client.createEvent(event);
        eventsChanged();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    }
  );

  server.tool(
    "delete_activity",
    "Delete an activity from intervals.icu by its activity ID. Use with caution — this is irreversible.",
    {
      id: z.string().describe("The activity ID to delete"),
    },
    async ({ id }) => {
      const result = await client.deleteActivity(id);
      activitiesChanged(id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "delete_event",
    "Delete a planned workout or event from the intervals.icu calendar by its event ID. Use with caution — this is irreversible.",
    {
      id: z.number().describe("The event ID to delete (numeric)"),
    },
    async ({ id }) => {
      const result = await client.deleteEvent(id);
      eventsChanged();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
