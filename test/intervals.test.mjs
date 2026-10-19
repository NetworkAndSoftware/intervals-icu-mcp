import { test } from "node:test";
import assert from "node:assert/strict";
import { activityUrl, API, AUTH, call, COACHED, connect, fakeIntervals, ME } from "./helpers.mjs";

const PUT_URL = `${API}/activity/i555/intervals?all=true`;
const STREAMS_URL = `${API}/activity/i555/streams?types=time`;

const get = (athlete) => ({ method: "GET", url: activityUrl(athlete, "i555"), auth: AUTH });
const streams = { method: "GET", url: STREAMS_URL, auth: AUTH };

// 1 s samples, with recording paused from 300 s to 400 s: index 300 is at 400 s, the last (499) at 599 s
const TIME = [...Array(300).keys(), ...Array.from({ length: 200 }, (_, k) => 400 + k)];
const activity = (owner) => ({
  id: "i555", icu_athlete_id: owner, source: "GARMIN_CONNECT", elapsed_time: 600,
  icu_intervals: [{ id: 1, type: "WORK", start_index: 10, end_index: 20, start_time: 10, end_time: 20 }],
});

// intervals.icu's answer to the PUT: the intervals it now has, with stats and plenty of nulls
const replaced = (body) => ({
  id: "i555",
  analyzed: "2026-10-19T08:00:00Z",
  icu_intervals: body.map((iv, k) => ({ id: k + 1, ...iv, elapsed_time: iv.end_time - iv.start_time, average_watts: 250, average_smo2: null })),
  icu_groups: [],
});

const routes = (owner) => ({
  [`GET ${activityUrl(owner, "i555")}`]: [activity(owner)],
  [`GET ${STREAMS_URL}`]: [{ type: "time", data: TIME }],
  [`PUT ${PUT_URL}`]: replaced,
});

const INTERVALS = [
  { start_time: 60, end_time: 240, type: "WORK", label: "VO2 1" },
  // Starts where the previous one ends, and runs across the pause
  { start_time: 240, end_time: 450, type: "RECOVERY" },
  // type defaults to WORK; ends at the activity's elapsed_time, after the last sample
  { start_time: 450, end_time: 600 },
];

const SENT = [
  { start_index: 60, end_index: 240, start_time: 60, end_time: 240, type: "WORK", label: "VO2 1" },
  { start_index: 240, end_index: 350, start_time: 240, end_time: 450, type: "RECOVERY" },
  { start_index: 350, end_index: 499, start_time: 450, end_time: 600, type: "WORK" },
];

test("set_activity_intervals and coach_set_activity_intervals are listed, with their required fields", async () => {
  const { tools } = await (await connect()).listTools();
  const own = tools.find(t => t.name === "set_activity_intervals");
  const coach = tools.find(t => t.name === "coach_set_activity_intervals");
  assert.ok(own && coach);
  assert.deepEqual(own.inputSchema.required, ["id", "intervals"]);
  assert.deepEqual(coach.inputSchema.required, ["athlete_id", "id", "intervals"]);
  assert.deepEqual(own.inputSchema.properties.intervals.items.required, ["start_time", "end_time"]);
  assert.deepEqual(own.inputSchema.properties.intervals.items.properties.type.enum, ["WORK", "RECOVERY"]);
  assert.match(own.description, /Replace/);
  assert.match(coach.description, /use set_activity_intervals/);
});

test("set_activity_intervals replaces the intervals, by stream index, and returns intervals.icu's", async () => {
  const requests = fakeIntervals(routes(ME));
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", intervals: INTERVALS });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [get(ME), streams, { method: "PUT", url: PUT_URL, auth: AUTH, body: SENT }]);
  assert.deepEqual(JSON.parse(result.text), {
    id: "i555",
    icu_intervals: SENT.map((iv, k) => ({ id: k + 1, ...iv, elapsed_time: iv.end_time - iv.start_time, average_watts: 250 })),
  });
});

test("coach_set_activity_intervals does the same on a coached athlete's activity", async () => {
  const requests = fakeIntervals(routes(COACHED));
  const result = await call(await connect(), "coach_set_activity_intervals", { athlete_id: COACHED, id: "i555", intervals: INTERVALS });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests, [get(COACHED), streams, { method: "PUT", url: PUT_URL, auth: AUTH, body: SENT }]);
  assert.equal(JSON.parse(result.text).icu_intervals.length, 3);
});

const INVALID = [
  ["unsorted", [{ start_time: 300, end_time: 400 }, { start_time: 100, end_time: 200 }], /sort the intervals by start_time/],
  ["overlapping", [{ start_time: 0, end_time: 200 }, { start_time: 150, end_time: 300 }], /may not overlap/],
  ["starting together", [{ start_time: 100, end_time: 200 }, { start_time: 100, end_time: 150 }], /may not overlap/],
  ["negative", [{ start_time: -10, end_time: 100 }], /start_time/],
  ["ending at its start", [{ start_time: 100, end_time: 100 }], /ends at 100 s, not after its start at 100 s/],
  ["ending before its start", [{ start_time: 200, end_time: 100 }], /not after its start/],
  ["fractional", [{ start_time: 10.5, end_time: 100 }], /start_time/],
  ["of an unknown type", [{ start_time: 0, end_time: 100, type: "REST" }], /type/],
  ["empty", [], /intervals/],
];

test("set_activity_intervals refuses invalid intervals before sending any request", async () => {
  const requests = fakeIntervals(routes(ME));
  const client = await connect();
  for (const [what, intervals, message] of INVALID) {
    for (const [name, args] of [["set_activity_intervals", {}], ["coach_set_activity_intervals", { athlete_id: COACHED }]]) {
      const result = await call(client, name, { ...args, id: "i555", intervals });
      assert.equal(result.isError, true, `${name} took intervals ${what}`);
      assert.match(result.text, message, `${name}, ${what}`);
    }
  }
  assert.deepEqual(requests, []);
});

test("set_activity_intervals refuses intervals past the activity's end, after only reading the activity", async () => {
  const requests = fakeIntervals(routes(ME));
  const result = await call(await connect(), "set_activity_intervals", {
    id: "i555", intervals: [{ start_time: 0, end_time: 300 }, { start_time: 300, end_time: 601, label: "Sprint" }],
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /Interval 2 "Sprint" ends at 601 s, after the activity ends \(elapsed_time 600 s\)/);
  assert.deepEqual(requests, [get(ME)]);
});

test("set_activity_intervals refuses an interval while recording was paused, without writing", async () => {
  const requests = fakeIntervals(routes(ME));
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", intervals: [{ start_time: 310, end_time: 390 }] });
  assert.equal(result.isError, true);
  assert.match(result.text, /no samples between 310 s and 390 s/);
  assert.deepEqual(requests, [get(ME), streams]);
});

// The PUT path names no athlete, so only the owner check keeps a tool to its own account
test("set_activity_intervals refuses a coached athlete's activity", async () => {
  const requests = fakeIntervals({ [`GET ${activityUrl(ME, "i555")}`]: [activity(COACHED)] });
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", intervals: INTERVALS });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i200/);
  assert.deepEqual(requests, [get(ME)]);
});

test("coach_set_activity_intervals refuses the user's own athlete ID", async () => {
  const requests = fakeIntervals({});
  const result = await call(await connect(), "coach_set_activity_intervals", { athlete_id: ME, id: "i555", intervals: INTERVALS });
  assert.equal(result.isError, true);
  assert.match(result.text, /your own account: use set_activity_intervals/);
  assert.deepEqual(requests, []);
});

test("set_activity_intervals drops the cached activity, so get_activity shows the new intervals", async () => {
  const requests = fakeIntervals(routes(ME));
  const client = await connect();
  await call(client, "get_activity", { id: "i555" });
  assert.equal((await call(client, "set_activity_intervals", { id: "i555", intervals: INTERVALS })).isError, false);
  await call(client, "get_activity", { id: "i555" });
  // The owner check used the cached activity; the read after the write fetched it again
  assert.deepEqual(requests.map(r => r.method), ["GET", "GET", "PUT", "GET"]);
  assert.deepEqual(requests.at(-1), get(ME));
});
