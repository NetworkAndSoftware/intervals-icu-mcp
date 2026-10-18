import { z } from "zod";
import { readFile } from "fs/promises";
import type { Cache } from "../cache.js";
import { addDays, dayOfWeek } from "../dates.js";
import { getActivity, getEvent, type Tools } from "./accounts.js";

// Writes must drop what they make stale, or reads keep serving the old data for up to
// the TTL (forever, for a single activity)
const eventsChanged = (cache: Cache) => cache.deletePrefix("events:");
const activitiesChanged = (cache: Cache, id?: string) => {
  for (const prefix of ["activities:", "fitness:", "power_curve:"]) cache.deletePrefix(prefix);
  if (id) {
    cache.delete(`activity:${id}`);
    cache.deletePrefix(`streams:${id}:`);
  }
};

export function registerUploadTools(
  tools: Tools,
  // Off when hosted remotely: there's no user disk there, and reading the host's
  // filesystem (e.g. /proc/self/environ) would leak its credentials
  { allowLocalFiles = true }: { allowLocalFiles?: boolean } = {}
) {
  if (allowLocalFiles) tools.add(
    "upload_activity",
    "Upload a completed activity file (.fit, .gpx, .tcx, .fit.gz) to intervals.icu.",
    {
      file_path: z.string().describe("Absolute path to the activity file on disk"),
      name: z.string().optional().describe("Optional activity name"),
      description: z.string().optional().describe("Optional activity description"),
    },
    async ({ file_path, name, description }, { client, cache }) => {
      const fileBuffer = await readFile(file_path);
      const filename = file_path.replace(/\\/g, "/").split("/").pop() || "activity.fit";
      const result = await client.uploadActivity(fileBuffer, filename, name, description);
      activitiesChanged(cache);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tools.add(
    "create_event",
    "Create an event on the intervals.icu calendar. Events include planned workouts, targets, notes, races, and more.",
    {
      start_date: z.string().describe("Date for the event (ISO format, e.g. 2024-01-15)"),
      // intervals.icu rejects unknown categories (e.g. "RACE", "REST_DAY") with a bare "JSON parse error"
      category: z
        .enum(["WORKOUT", "RACE_A", "RACE_B", "RACE_C", "TARGET", "NOTE", "HOLIDAY", "SICK", "INJURED"])
        .describe("Event category. Races carry their priority: RACE_A (goal race), RACE_B, RACE_C. HOLIDAY, SICK and INJURED mark days off training"),
      name: z.string().describe("Event name"),
      type: z.string().optional().describe('Activity type (e.g. "Ride", "Run", "Swim", "Rowing"). Defaults to "Ride"'),
      load_target: z.number().optional().describe("Planned training load (TSS)"),
      time_target: z.number().optional().describe("Planned duration in seconds"),
      distance_target: z.number().optional().describe("Planned distance in meters"),
      description: z.string().optional().describe("Optional description/notes"),
      color: z.string().optional().describe("Optional color for the calendar event (e.g. 'red', '#ff0000')"),
      indoor: z.boolean().optional().describe("Whether this is an indoor workout"),
      file_path: z.string().optional().describe("Optional: absolute path to a workout file (.fit, .zwo, .mrc, .erg)"),
    },
    async ({ start_date, category, name, type, load_target, time_target, distance_target, description, color, indoor, file_path }, { client, cache }) => {
      const event: Record<string, unknown> = {
        category,
        start_date_local: `${start_date}T00:00:00`,
        name,
        type: type || "Ride",
      };

      if (load_target != null) {
        event.load_target = load_target;
        event.icu_training_load = load_target;
      }
      if (time_target != null) {
        event.time_target = time_target;
        event.moving_time = time_target;
      }
      if (distance_target != null) {
        event.distance_target = distance_target;
        event.distance = distance_target;
      }
      if (description) event.description = description;
      if (color) event.color = color;
      if (indoor != null) event.indoor = indoor;

      if (file_path) {
        if (!allowLocalFiles) {
          return { content: [{ type: "text", text: "file_path is not supported on the remote server" }], isError: true };
        }
        const fileBuffer = await readFile(file_path);
        const filename = file_path.replace(/\\/g, "/").split("/").pop() || "workout.fit";
        event.filename = filename;
        event.file_contents_base64 = fileBuffer.toString("base64");
      }

      const result = await client.createEvent(event);
      eventsChanged(cache);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tools.add(
    "update_event",
    "Update an existing planned workout or event on the intervals.icu calendar. Only provide the fields you want to change.",
    {
      id: z.number().describe(`The event ID to update (numeric, from ${tools.name("get_events")})`),
      name: z.string().optional().describe("New workout name"),
      description: z.string().optional().describe("New description/notes"),
      load_target: z.number().optional().describe("Planned training load (TSS)"),
      time_target: z.number().optional().describe("Planned duration in seconds"),
      distance_target: z.number().optional().describe("Planned distance in meters"),
      color: z.string().optional().describe("Calendar event color"),
      indoor: z.boolean().optional().describe("Whether this is an indoor workout"),
      type: z.string().optional().describe('Activity type (e.g. "Ride", "Run", "Rowing")'),
    },
    async ({ id, ...fields }, account) => {
      const { client, cache } = account;
      await getEvent(account, id);

      const update: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v != null) update[k] = v;
      }
      if (update.load_target != null) {
        update.icu_training_load = update.load_target;
      }
      if (update.time_target != null) {
        update.moving_time = update.time_target;
      }
      if (update.distance_target != null) {
        update.distance = update.distance_target;
      }
      const result = await client.updateEvent(id, update);
      eventsChanged(cache);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tools.add(
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
    async ({ week_start, type, load_target, time_target, distance_target, description }, { client, cache }) => {
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
        eventsChanged(cache);
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
        eventsChanged(cache);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    }
  );

  tools.add(
    "delete_activity",
    "Delete an activity from intervals.icu by its activity ID. Use with caution — this is irreversible.",
    {
      id: z.string().describe("The activity ID to delete"),
    },
    async ({ id }, account) => {
      await getActivity(account, id);
      const result = await account.client.deleteActivity(id);
      activitiesChanged(account.cache, id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  tools.add(
    "delete_event",
    "Delete a planned workout or event from the intervals.icu calendar by its event ID. Use with caution — this is irreversible.",
    {
      id: z.number().describe("The event ID to delete (numeric)"),
    },
    async ({ id }, account) => {
      await getEvent(account, id);
      const result = await account.client.deleteEvent(id);
      eventsChanged(account.cache);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
