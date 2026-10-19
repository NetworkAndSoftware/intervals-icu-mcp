import { test } from "node:test";
import assert from "node:assert/strict";
import { IntervalsClient } from "../dist/api.js";
import { activityUrl, API, AUTH, call, COACHED, connect, fakeIntervals, KEY, ME, OTHER } from "./helpers.mjs";

const get = (athlete, id) => ({ method: "GET", url: activityUrl(athlete, id), auth: AUTH });
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
    [`GET ${API}/athlete/${COACHED}/activities/i555?intervals=true`]: [{ id: "i555", icu_athlete_id: COACHED }],
    [`DELETE ${API}/activity/i555`]: { id: "i555" },
  });
  const result = await call(await connect(), "coach_delete_activity", { athlete_id: COACHED, id: "i555" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), { deleted: true, id: "i555" });
  assert.deepEqual(requests, [get(COACHED, "i555"), del("i555")]);
});

test("delete_activity deletes the user's own activity", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${ME}/activities/i555?intervals=true`]: [{ id: "i555", icu_athlete_id: ME }],
    [`DELETE ${API}/activity/i555`]: { id: "i555" },
  });
  const result = await call(await connect(), "delete_activity", { id: "i555" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [get(ME, "i555"), del("i555")]);
});

// The DELETE path names no athlete, so only the owner check keeps a tool to its own account
test("delete_activity refuses a coached athlete's activity", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${ME}/activities/i555?intervals=true`]: [{ id: "i555", icu_athlete_id: COACHED }],
  });
  const result = await call(await connect(), "delete_activity", { id: "i555" });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i200/);
  assert.deepEqual(requests, [get(ME, "i555")]);
});

test("coach_delete_activity refuses an activity of a different athlete", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${COACHED}/activities/i555?intervals=true`]: [{ id: "i555", icu_athlete_id: OTHER }],
  });
  const result = await call(await connect(), "coach_delete_activity", { athlete_id: COACHED, id: "i555" });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i300/);
  assert.deepEqual(requests, [get(COACHED, "i555")]);
});

test("coach_delete_activity refuses an ID intervals.icu doesn't find for the athlete, without caching that", async () => {
  // intervals.icu leaves out IDs it doesn't find instead of answering 404
  const requests = fakeIntervals({ [`GET ${API}/athlete/${COACHED}/activities/i555?intervals=true`]: [] });
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
    [`GET ${API}/athlete/${COACHED}/activities/i555?intervals=true`]: [activity],
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
    [`GET ${API}/athlete/${ME}/activities/i555?intervals=true`]: [{ id: "i555", icu_athlete_id: COACHED }],
  });
  const result = await call(await connect(), "get_activity_streams", { id: "i555", types: ["watts"] });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i200/);
  assert.deepEqual(requests, [get(ME, "i555")]);
});

// Activity IDs go into URL paths unescaped, so anything else could reach another path
const BAD_IDS = [
  `../../../../../../api/v1/athlete/${OTHER}/events/5`,
  // Without the check, this made delete_activity a range delete of another athlete's calendar
  `../../../../../../api/v1/athlete/${OTHER}/events?oldest=2026-01-01&category=WORKOUT`,
  `i555/../../athlete/${OTHER}/events/5`,
  "i555,i556",
  "i555?oldest=2026-01-01",
  "%2e%2e%2fi556",
  "i555 ",
  "i0",
  "",
];

test("tools taking an activity ID refuse anything else, before sending a request", async () => {
  const requests = fakeIntervals({});
  const client = await connect();
  const tools = [
    ["get_activity", {}],
    ["get_activity_streams", { types: ["watts"] }],
    ["delete_activity", {}],
    ["coach_get_activity", { athlete_id: COACHED }],
    ["coach_get_activity_streams", { athlete_id: COACHED, types: ["watts"] }],
    ["coach_delete_activity", { athlete_id: COACHED }],
  ];
  for (const [name, args] of tools) {
    for (const id of BAD_IDS) {
      const result = await call(client, name, { ...args, id });
      assert.equal(result.isError, true, `${name} took ${JSON.stringify(id)}`);
      assert.match(result.text, /activity ID/);
    }
  }
  assert.deepEqual(requests, []);
});

test("delete_activity takes a Strava activity's numeric ID", async () => {
  const requests = fakeIntervals({
    [`GET ${API}/athlete/${ME}/activities/12345678901?intervals=true`]: [{ id: "12345678901", icu_athlete_id: ME, source: "STRAVA" }],
    [`DELETE ${API}/activity/12345678901`]: { id: "12345678901" },
  });
  const result = await call(await connect(), "delete_activity", { id: "12345678901" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [get(ME, "12345678901"), del("12345678901")]);
});

const LIST_URL = `${API}/athlete/${ME}/activities?oldest=2026-10-01&newest=2026-10-18`;
const LIST = [
  { id: "i1", name: "Rabbit Ride", source: "GARMIN_CONNECT", oauth_client_name: null, icu_training_load: 200, average_watts: 208 },
  { id: "i2", name: "Zwift ride", source: "OAUTH_CLIENT", oauth_client_name: "Zwift", icu_training_load: 60, average_watts: 190 },
  { id: "i3", name: "Rabbit Ride", source: "WAHOO", oauth_client_name: null, icu_training_load: 180, average_watts: null },
];

test("get_activities without the new arguments returns the full activities as before", async () => {
  fakeIntervals({ [`GET ${LIST_URL}`]: LIST });
  const result = await call(await connect(), "get_activities", { oldest: "2026-10-01", newest: "2026-10-18" });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.text, JSON.stringify(LIST, null, 2));
});

test("get_activities with fields returns only those fields, plus id, keeping nulls", async () => {
  fakeIntervals({ [`GET ${LIST_URL}`]: LIST });
  const result = await call(await connect(), "get_activities", {
    oldest: "2026-10-01", newest: "2026-10-18", fields: ["name", "average_watts", "no_such_field"],
  });
  assert.deepEqual(JSON.parse(result.text), [
    { id: "i1", name: "Rabbit Ride", average_watts: 208 },
    { id: "i2", name: "Zwift ride", average_watts: 190 },
    { id: "i3", name: "Rabbit Ride", average_watts: null },
  ]);
});

test("get_activities filters on source and oauth_client_name exactly, with the name query", async () => {
  const requests = fakeIntervals({ [`GET ${LIST_URL}`]: LIST });
  const client = await connect();
  const args = { oldest: "2026-10-01", newest: "2026-10-18", fields: ["id"] };
  const ids = async (more) => JSON.parse((await call(client, "get_activities", { ...args, ...more })).text).map(a => a.id);
  assert.deepEqual(await ids({ source: "WAHOO" }), ["i3"]);
  assert.deepEqual(await ids({ source: "wahoo" }), []);
  assert.deepEqual(await ids({ oauth_client_name: "Zwift" }), ["i2"]);
  assert.deepEqual(await ids({ source: "OAUTH_CLIENT", oauth_client_name: "Zwift" }), ["i2"]);
  assert.deepEqual(await ids({ query: "rabbit", source: "GARMIN_CONNECT" }), ["i1"]);
  // One fetch: the filters work on the cached list
  assert.equal(requests.length, 1);
});

test("get_activity returns the activity compactly, without its intervals, empty fields or chart", async () => {
  const activity = { id: "i555", icu_athlete_id: ME, name: "Ride", icu_ftp: 321, interval_summary: ["1x 3m 350w"] };
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [{
      ...activity, carbs_used: null, skyline_chart_bytes: "CAcSHv0Z",
      icu_intervals: [{ id: 1, start_index: 0, end_index: 180 }], icu_groups: [{ id: "180s@350w" }],
    }],
  });
  const result = await call(await connect(), "get_activity", { id: "i555" });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.text, JSON.stringify([activity]));
  // Fetched with its intervals all the same, so get_activity_intervals can use the same cache entry
  assert.deepEqual(requests, [get(ME, "i555")]);
});
