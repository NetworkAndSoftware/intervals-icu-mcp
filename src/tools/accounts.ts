import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IntervalsClient } from "../api.js";
import { Cache, PrefixedCache, TTL } from "../cache.js";

type Json = Record<string, unknown>;

// The intervals.icu account a tool call acts on, and the cache for its data
export type Account = { client: IntervalsClient; cache: Cache };

// Registers tools for one kind of account. The tool modules register each tool through both
// ownTools and coachTools, so every tool exists twice: once for the user's own account and
// once, as coach_<name>, for athletes they coach. Claude keeps permission settings per tool,
// so permission given for your own account never covers someone else's.
// (server.tool can't type a callback for a schema that's still generic, so both register the
// general shape and cast the arguments back for the handler.)
export type Tools = {
  // The name a tool is registered under here, for descriptions that mention another tool
  name(tool: string): string;
  add<Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    handler: (args: ShapeOutput<Args>, account: Account) => Promise<CallToolResult>
  ): void;
};

export function ownTools(server: McpServer, own: Account): Tools {
  return {
    name: (tool) => tool,
    add(name, description, schema, handler) {
      server.tool<ZodRawShapeCompat>(name, description, schema, (args) => handler(args as ShapeOutput<typeof schema>, own));
    },
  };
}

export function coachTools(server: McpServer, own: Account): Tools {
  return {
    name: (tool) => `coach_${tool}`,
    add(name, description, schema, handler) {
      server.tool<ZodRawShapeCompat>(
        `coach_${name}`,
        `For an athlete you coach, by athlete_id (not your own account: use ${name}). ${description}`,
        {
          athlete_id: z
            .string()
            .regex(/^i?[1-9]\d*$/, 'An intervals.icu athlete ID, like "i12345"')
            .describe('Athlete ID of the athlete you coach, e.g. "i12345", from coach_list_athletes'),
          ...schema,
        },
        async ({ athlete_id, ...args }) => {
          if (athlete_id === own.client.athleteId) {
            return { content: [{ type: "text", text: `${athlete_id} is your own account: use ${name}` }], isError: true };
          }
          return handler(args as ShapeOutput<typeof schema>, {
            client: own.client.forAthlete(athlete_id as string),
            cache: new PrefixedCache(own.cache, `coached:${athlete_id}:`),
          });
        }
      );
    },
  };
}

// Activity IDs go into URL paths as they are, so one like "../../athlete/i2/events/5" would
// reach another path, past the owner check below. intervals.icu's own IDs are "i" + digits;
// activities from Strava keep their numeric Strava ID.
export const activityId = z.string().regex(/^i?[1-9]\d*$/, 'An intervals.icu activity ID, like "i12345"');

// intervals.icu may not check that an activity or event ID belongs to the athlete in the
// request path (activity streams don't even have one in theirs), so a tool given an ID from
// another account's data could act on that account, bypassing the permission settings of the
// tools for it. Records without an owner field are let through.
function checkOwner(account: Account, record: string, owner: unknown) {
  if (owner != null && owner !== account.client.athleteId) {
    throw new Error(`${record} belongs to athlete ${owner}, not ${account.client.athleteId}`);
  }
}

export const activityCacheKey = (id: string) => `activity:${id}:intervals`;

// The activity path takes a list of IDs and answers with a list, leaving out IDs it doesn't
// find. The delete and streams paths have no athlete in them, so an ID that finds nothing
// here is refused rather than passed on to them.
export async function getActivity(account: Account, id: string): Promise<Json[]> {
  // Not plain activity:{id}, which the SQLite cache may still hold without intervals, forever
  const cacheKey = activityCacheKey(id);
  let activities = account.cache.get<Json[]>(cacheKey);
  if (!activities?.length) {
    const result = await account.client.getActivity(id);
    activities = Array.isArray(result) ? result as Json[] : [];
    if (!activities.length) throw new Error(`Activity ${id} not found in ${account.client.athleteId}'s activities`);
    account.cache.set(cacheKey, activities, TTL.NEVER);
  }
  for (const activity of activities) checkOwner(account, `Activity ${id}`, activity.icu_athlete_id);
  return activities;
}

export async function getEvent(account: Account, id: number): Promise<Json> {
  const event = await account.client.getEvent(id) as Json;
  checkOwner(account, `Event ${id}`, event.athlete_id);
  return event;
}
