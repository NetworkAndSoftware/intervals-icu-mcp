// Runs against the build in dist/ (npm test builds it first)
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IntervalsClient } from "../dist/api.js";
import { MemoryCache } from "../dist/cache.js";
import { createMcpServer } from "../dist/server.js";

const API = "https://intervals.icu/api/v1";
const ME = "i100";
const COACHED = "i200";
const OTHER = "i300";
const KEY = "test-key";
const AUTH = "Basic " + Buffer.from(`API_KEY:${KEY}`).toString("base64");

// Stands in for intervals.icu: answers the routes a test lists ("METHOD url": JSON body) and
// records every request. Anything else gets a 405, as intervals.icu answers a method a path
// doesn't support. Nothing reaches the network, so no real activity is ever deleted.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeIntervals(routes) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    requests.push({ method, url: String(url), auth: init.headers?.Authorization });
    const body = routes[`${method} ${url}`];
    if (body === undefined) {
      return new Response(JSON.stringify({ status: 405, error: "Method Not Allowed" }), { status: 405, statusText: "Method Not Allowed" });
    }
    return Response.json(body);
  };
  return requests;
}

// The MCP server as Lambda runs it, with a client connected to it in memory
async function connect() {
  const server = createMcpServer(new IntervalsClient(ME, KEY), new MemoryCache(), { remote: true });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError ?? false, text: result.content[0].text };
}

const get = (athlete, id) => ({ method: "GET", url: `${API}/athlete/${athlete}/activities/${id}`, auth: AUTH });
const del = (id) => ({ method: "DELETE", url: `${API}/activity/${id}`, auth: AUTH });

test("deleteActivity sends DELETE /activity/{id} with the user's key, for a coached athlete too", async () => {
  const requests = fakeIntervals({ [`DELETE ${API}/activity/i555`]: { id: "i555" } });
  const client = new IntervalsClient(ME, KEY);
  assert.deepEqual(await client.deleteActivity("i555"), { deleted: true, id: "i555" });
  assert.deepEqual(await client.forAthlete(COACHED).deleteActivity("i555"), { deleted: true, id: "i555" });
  assert.deepEqual(requests, [del("i555"), del("i555")]);
});

test("coach_delete_activity checks the activity is the coached athlete's, then deletes it", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${COACHED}/activities/i555`]: [{ id: "i555", icu_athlete_id: COACHED }],
    [`DELETE ${API}/activity/i555`]: { id: "i555" },
  });
  const result = await call(await connect(), "coach_delete_activity", { athlete_id: COACHED, id: "i555" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), { deleted: true, id: "i555" });
  assert.deepEqual(requests, [get(COACHED, "i555"), del("i555")]);
});

test("delete_activity deletes the user's own activity", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${ME}/activities/i555`]: [{ id: "i555", icu_athlete_id: ME }],
    [`DELETE ${API}/activity/i555`]: { id: "i555" },
  });
  const result = await call(await connect(), "delete_activity", { id: "i555" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [get(ME, "i555"), del("i555")]);
});

// The DELETE path names no athlete, so only the owner check keeps a tool to its own account
test("delete_activity refuses a coached athlete's activity", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${ME}/activities/i555`]: [{ id: "i555", icu_athlete_id: COACHED }],
  });
  const result = await call(await connect(), "delete_activity", { id: "i555" });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i200/);
  assert.deepEqual(requests, [get(ME, "i555")]);
});

test("coach_delete_activity refuses an activity of a different athlete", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${COACHED}/activities/i555`]: [{ id: "i555", icu_athlete_id: OTHER }],
  });
  const result = await call(await connect(), "coach_delete_activity", { athlete_id: COACHED, id: "i555" });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i300/);
  assert.deepEqual(requests, [get(COACHED, "i555")]);
});

test("coach_delete_activity refuses an ID intervals.icu doesn't find for the athlete, without caching that", async () => {
  // intervals.icu leaves out IDs it doesn't find instead of answering 404
  const requests = fakeIntervals({ [`GET ${API}/athlete/${COACHED}/activities/i555`]: [] });
  const client = await connect();
  for (let i = 0; i < 2; i++) {
    const result = await call(client, "coach_delete_activity", { athlete_id: COACHED, id: "i555" });
    assert.equal(result.isError, true);
    assert.match(result.text, /not found/);
  }
  assert.deepEqual(requests, [get(COACHED, "i555"), get(COACHED, "i555")]);
});

test("coach_delete_activity refuses the user's own athlete ID", async () => {
  const requests = fakeIntervals({});
  const result = await call(await connect(), "coach_delete_activity", { athlete_id: ME, id: "i555" });
  assert.equal(result.isError, true);
  assert.match(result.text, /your own account: use delete_activity/);
  assert.deepEqual(requests, []);
});

test("get_activity returns intervals.icu's answer as before, and a delete drops it from the cache", async () => {
  const activity = { id: "i555", icu_athlete_id: COACHED, name: "Ride" };
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${COACHED}/activities/i555`]: [activity],
    [`DELETE ${API}/activity/i555`]: { id: "i555" },
  });
  const client = await connect();
  const args = { athlete_id: COACHED, id: "i555" };
  assert.deepEqual(JSON.parse((await call(client, "coach_get_activity", args)).text), [activity]);
  assert.equal((await call(client, "coach_delete_activity", args)).isError, false);
  await call(client, "coach_get_activity", args);
  // The delete's owner check used the cached activity; the read after it fetched again
  assert.deepEqual(requests, [get(COACHED, "i555"), del("i555"), get(COACHED, "i555")]);
});

test("get_activity_streams refuses another account's activity", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${ME}/activities/i555`]: [{ id: "i555", icu_athlete_id: COACHED }],
  });
  const result = await call(await connect(), "get_activity_streams", { id: "i555", types: ["watts"] });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i200/);
  assert.deepEqual(requests, [get(ME, "i555")]);
});
