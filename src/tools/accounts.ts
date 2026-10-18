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

// intervals.icu may not check that an activity or event ID belongs to the athlete in the
// request path (activity streams don't even have one in theirs), so a tool given an ID from
// another account's data could act on that account, bypassing the permission settings of the
// tools for it. Records without an owner field are let through.
function checkOwner(account: Account, record: string, owner: unknown) {
  if (owner != null && owner !== account.client.athleteId) {
    throw new Error(`${record} belongs to athlete ${owner}, not ${account.client.athleteId}`);
  }
}

export async function getActivity(account: Account, id: string): Promise<Json> {
  const cacheKey = `activity:${id}`;
  let activity = account.cache.get<Json>(cacheKey);
  if (!activity) {
    activity = await account.client.getActivity(id) as Json;
    account.cache.set(cacheKey, activity, TTL.NEVER);
  }
  checkOwner(account, `Activity ${id}`, activity.icu_athlete_id);
  return activity;
}

export async function getEvent(account: Account, id: number): Promise<Json> {
  const event = await account.client.getEvent(id) as Json;
  checkOwner(account, `Event ${id}`, event.athlete_id);
  return event;
}
