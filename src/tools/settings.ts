import { z } from "zod";
import type { IntervalsClient } from "../api.js";
import { Cache, TTL } from "../cache.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type Json = Record<string, unknown>;

// An allowlist, not a blocklist: the athlete record also holds the intervals.icu API key,
// email address and third-party tokens, none of which may leave the server.
// API field name → name returned by the tools
const ATHLETE_FIELDS: Record<string, string> = {
  id: "id",
  name: "name",
  sex: "sex",
  icu_date_of_birth: "date_of_birth",
  timezone: "timezone",
  icu_weight: "weight_kg",
  icu_resting_hr: "resting_hr",
  height: "height_m",
  measurement_preference: "measurement_preference",
  weight_pref_lb: "weight_pref_lb",
  height_units: "height_units",
  fahrenheit: "fahrenheit",
};

const SPORT_FIELDS = [
  "id", "types", "ftp", "indoor_ftp", "w_prime", "p_max", "power_zones",
  "lthr", "max_hr", "hr_zones", "threshold_pace", "pace_units",
];

function summarizeAthlete(athlete: Json): Json {
  const out: Json = {};
  for (const [from, to] of Object.entries(ATHLETE_FIELDS)) {
    if (athlete[from] != null) out[to] = athlete[from];
  }
  return out;
}

function summarizeSport(settings: Json): Json {
  const out: Json = {};
  for (const k of SPORT_FIELDS) {
    if (settings[k] != null) out[k] = settings[k];
  }
  return out;
}

export function registerSettingsTools(
  server: McpServer,
  client: IntervalsClient,
  cache: Cache
) {
  server.tool(
    "get_athlete_settings",
    "Get the athlete's general settings: profile (weight in kg, resting HR, height in m, date of birth, display unit preferences) and, for each sport-settings entry, the thresholds — FTP, indoor FTP, W′, Pmax, LTHR, max HR, threshold pace (m/s) — with power zones (upper bounds, % of FTP) and HR zones (upper bounds, bpm). Each sport entry applies to every activity type in its `types` list. Use get_athlete_zones for zone names and the full per-sport configuration.",
    {},
    async () => {
      const cacheKey = "athlete_settings";
      const cached = cache.get<unknown>(cacheKey);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

      const athlete = await client.getAthlete() as Json;
      const data = {
        athlete: summarizeAthlete(athlete),
        sports: ((athlete.sportSettings as Json[] | undefined) ?? []).map(summarizeSport),
      };
      cache.set(cacheKey, data, TTL.ONE_DAY);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "update_athlete_settings",
    "Update the athlete's profile settings in intervals.icu. Only provide the fields you want to change. Values are always metric, whatever units the athlete displays.",
    {
      weight_kg: z.number().positive().optional().describe("Profile weight in kilograms (separate from daily wellness weight entries)"),
      resting_hr: z.number().int().positive().optional().describe("Resting heart rate in bpm"),
      height_m: z.number().positive().optional().describe("Height in meters"),
      date_of_birth: z.string().optional().describe("Date of birth (ISO format, e.g. 1980-05-31)"),
    },
    async ({ weight_kg, resting_hr, height_m, date_of_birth }) => {
      const update: Json = {};
      if (weight_kg != null) update.icu_weight = weight_kg;
      if (resting_hr != null) update.icu_resting_hr = resting_hr;
      if (height_m != null) update.height = height_m;
      if (date_of_birth) update.icu_date_of_birth = date_of_birth;
      if (Object.keys(update).length === 0) {
        return { content: [{ type: "text", text: "No settings to update" }], isError: true };
      }

      const result = await client.updateAthlete(update) as Json;
      cache.delete("athlete_settings");
      return { content: [{ type: "text", text: JSON.stringify(summarizeAthlete(result), null, 2) }] };
    }
  );

  server.tool(
    "update_sport_settings",
    "Update thresholds or zones for one sport in intervals.icu, e.g. max HR, LTHR or FTP for cycling. A sport-settings entry is shared by all activity types in its `types` list (e.g. the Ride entry usually also covers VirtualRide and GravelRide — see get_athlete_settings), so changing it changes all of them. Only provide the fields you want to change. Does not reprocess activities already in intervals.icu.",
    {
      type: z.string().describe('An activity type in the entry to update, e.g. "Ride", "Run", "Rowing". Use "Other" for the fallback entry that covers types without their own settings.'),
      ftp: z.number().int().positive().optional().describe("Functional threshold power in watts"),
      indoor_ftp: z.number().int().positive().optional().describe("Separate FTP for indoor activities, in watts"),
      w_prime: z.number().int().positive().optional().describe("W′ (anaerobic work capacity) in joules"),
      p_max: z.number().int().positive().optional().describe("Maximum (sprint) power in watts"),
      lthr: z.number().int().positive().optional().describe("Lactate threshold heart rate in bpm"),
      max_hr: z.number().int().positive().optional().describe("Maximum heart rate in bpm. The last HR zone always ends at max HR."),
      threshold_pace: z.number().positive().optional().describe("Threshold pace in meters per second (e.g. 4.0 = 4:10/km)"),
      hr_zones: z.array(z.number().int().positive()).optional().describe("Custom HR zones: the upper bound of each zone in bpm, ascending. The last value is max HR."),
      power_zones: z.array(z.number().int().positive()).optional().describe("Custom power zones: the upper bound of each zone as % of FTP, ascending. The last value is conventionally 999."),
      recalc_hr_zones: z.boolean().optional().describe("Recompute HR zones from LTHR using intervals.icu's default percentages, replacing the current zone bounds, custom ones included. Defaults to false, which keeps the current bpm bounds. Has no effect when hr_zones is given."),
    },
    async ({ type, recalc_hr_zones, ...fields }) => {
      const update: Json = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v != null) update[k] = v;
      }
      if (Object.keys(update).length === 0) {
        return { content: [{ type: "text", text: "No settings to update" }], isError: true };
      }

      // Resolve the entry ourselves: updating by type name silently changes the "Other"
      // entry when no entry lists that type
      const entries = await client.getSportSettings() as Json[];
      const entry = entries.find(e =>
        (e.types as string[]).some(t => t.toLowerCase() === type.toLowerCase())
      );
      if (!entry) {
        const configured = entries.map(e => (e.types as string[]).join("/")).join(", ");
        return {
          content: [{ type: "text", text: `No sport settings entry lists "${type}". Configured entries: ${configured}` }],
          isError: true,
        };
      }

      const result = await client.updateSportSettings(entry.id as number, update, recalc_hr_zones ?? false) as Json;
      cache.delete("zones");
      cache.delete("athlete_settings");
      return { content: [{ type: "text", text: JSON.stringify(summarizeSport(result), null, 2) }] };
    }
  );
}
