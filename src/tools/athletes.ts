import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TTL } from "../cache.js";
import { addDays, getMonday } from "../dates.js";
import type { Account } from "./accounts.js";

type CoachedAthlete = { id: string; name: string };

export function registerAthleteListTool(server: McpServer, { client, cache }: Account) {
  server.tool(
    "coach_list_athletes",
    "List the athletes you coach on intervals.icu (everyone your account follows), with the athlete IDs the other coach_ tools take.",
    {},
    async () => {
      const cacheKey = "coached_athletes";
      let athletes = cache.get<CoachedAthlete[]>(cacheKey);
      if (!athletes) {
        // athlete-summary has weekly entries for the athlete and everyone they coach or follow.
        // A few weeks back, in case it leaves out an athlete's weeks without training.
        const today = await client.today();
        const summary = await client.getFitness(addDays(getMonday(today), -21), today) as Record<string, string>[];
        const names = new Map<string, string>();
        for (const entry of summary) {
          if (entry.athlete_id !== client.athleteId) names.set(entry.athlete_id, entry.athlete_name);
        }
        athletes = [...names]
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
        cache.set(cacheKey, athletes, TTL.ONE_HOUR);
      }

      if (athletes.length === 0) {
        return { content: [{ type: "text", text: "No coached athletes found. Athletes are listed once they've accepted you as their coach in intervals.icu." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(athletes, null, 2) }] };
    }
  );
}
