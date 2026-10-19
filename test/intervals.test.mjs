import { test } from "node:test";
import assert from "node:assert/strict";
import { activityUrl, API, AUTH, at, call, COACHED, connect, fakeIntervals, ME, ride, STREAMS_URL } from "./helpers.mjs";

const PUT_URL = (id, replace) => `${API}/activity/${id}/intervals?all=${replace}`;
const ACTIVITY = { id: "i555", icu_athlete_id: ME, name: "Rabbit Ride" };

// intervals.icu's answer to a PUT: the intervals it was sent (with these, merged with the
// others), each with an ID and figures of its own
const answer = (existing = []) => (sent) => ({
  id: "i555",
  icu_intervals: [...existing, ...sent].map((s, i) => ({ id: i + 1, ...s, average_watts: 300, average_smo2: null })),
});

const puts = (requests) => requests.filter(r => r.method === "PUT");

test("get_activity_intervals returns the main fields of each interval, from the same fetch as get_activity", async () => {
  const kept = {
    id: 7, type: "WORK", label: "Colony", start_index: 120, end_index: 300, start_time: 125, end_time: 305,
    distance: 1450.5, average_watts: 350, weighted_average_watts: 352, joules_above_ftp: 4500, wbal_start: 22500, wbal_end: 15000,
  };
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [{ ...ACTIVITY, icu_intervals: [{ ...kept, average_smo2: null, max_torque: 60 }] }],
  });
  const client = await connect();
  const result = await call(client, "get_activity_intervals", { id: "i555" });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.text, JSON.stringify([kept]));
  await call(client, "get_activity", { id: "i555" });
  assert.equal(requests.length, 1);
});

test("set_activity_intervals places intervals by time, distance and place, in ride order, and replaces the existing ones", async () => {
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`PUT ${PUT_URL("i555", true)}`]: answer(),
  });
  const result = await call(await connect(), "set_activity_intervals", {
    id: "i555",
    replace: true,
    intervals: [
      { label: "after the stop", start_s: 650, end_s: 5000, type: "RECOVERY" },
      { label: "by distance", start_m: 1000, end_m: 1600 },
      { label: "by place", start_point: at(2000), end_point: at(2500) },
    ],
  });
  assert.equal(result.isError, false, result.text);
  // end_index is exclusive; the last interval runs to the ride's end, past its last sample (899, at 999 s)
  const sent = [
    { start_index: 100, end_index: 160, start_time: 100, end_time: 160, type: "WORK", label: "by distance" },
    { start_index: 200, end_index: 250, start_time: 200, end_time: 250, type: "WORK", label: "by place" },
    { start_index: 600, end_index: 900, start_time: 700, end_time: 1000, type: "RECOVERY", label: "after the stop" },
  ];
  assert.deepEqual(puts(requests), [{ method: "PUT", url: PUT_URL("i555", true), auth: AUTH, body: sent }]);
  assert.deepEqual(JSON.parse(result.text), { intervals: sent.map((s, i) => ({ id: i + 1, ...s, average_watts: 300 })) });
});

test("set_activity_intervals merges with replace: false", async () => {
  const existing = { start_index: 10, end_index: 20, type: "WORK" };
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`PUT ${PUT_URL("i555", false)}`]: answer([existing]),
  });
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", replace: false, intervals: [{ start_s: 100, end_s: 160 }] });
  assert.equal(result.isError, false, result.text);
  assert.equal(puts(requests)[0].url, PUT_URL("i555", false));
  assert.equal(JSON.parse(result.text).intervals.length, 2);
});

test("set_activity_intervals writes nothing when an interval can't be placed or two overlap", async () => {
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
  });
  const client = await connect();
  const cases = [
    [[{ label: "a", start_s: 100, end_s: 200 }, { label: "b", start_s: 150, end_s: 250 }], /Nothing written\. a and b overlap/],
    [[{ label: "c", start_s: 100, end_s: 200 }, { label: "nowhere", start_point: [47, -121], end_s: 300 }], /Nothing written\. nowhere: No pass within 30 m of start_point/],
    [[{ start_s: 300, end_s: 200 }], /interval 1: The window ends before it starts/],
    [[{ label: "two starts", start_s: 0, start_m: 0, end_s: 10 }], /two starts: Give exactly one of start_s, start_m, start_point/],
  ];
  for (const [intervals, message] of cases) {
    const result = await call(client, "set_activity_intervals", { id: "i555", replace: true, intervals });
    assert.equal(result.isError, true, JSON.stringify(intervals));
    assert.match(result.text, message);
  }
  // Back to back is fine: the first ends where the second starts
  fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`PUT ${PUT_URL("i555", true)}`]: answer(),
  });
  const backToBack = await call(client, "set_activity_intervals", { id: "i555", replace: true, intervals: [{ start_s: 100, end_s: 200 }, { start_s: 200, end_s: 300 }] });
  assert.equal(backToBack.isError, false, backToBack.text);
  assert.deepEqual(puts(requests), []);
});

test("set_activity_intervals needs replace to be chosen", async () => {
  const requests = fakeIntervals({});
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", intervals: [{ start_s: 0, end_s: 10 }] });
  assert.equal(result.isError, true);
  assert.match(result.text, /replace/);
  assert.deepEqual(requests, []);
});

test("set_activity_intervals refuses another account's activity before fetching its streams", async () => {
  const requests = fakeIntervals({ [`GET ${activityUrl(ME, "i555")}`]: [{ ...ACTIVITY, icu_athlete_id: COACHED }] });
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", replace: true, intervals: [{ start_s: 0, end_s: 10 }] });
  assert.equal(result.isError, true);
  assert.match(result.text, /belongs to athlete i200/);
  assert.deepEqual(requests.map(r => r.url), [activityUrl(ME, "i555")]);
});

test("set_activity_intervals warns when intervals.icu's answer lacks an interval it was sent", async () => {
  fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`PUT ${PUT_URL("i555", true)}`]: { id: "i555", icu_intervals: [] },
  });
  const result = await call(await connect(), "set_activity_intervals", { id: "i555", replace: true, intervals: [{ start_s: 100, end_s: 160 }] });
  assert.equal(result.isError, false, result.text);
  assert.match(JSON.parse(result.text).warning, /lacks 1 of the 1 intervals sent/);
});

test("set_activity_intervals drops the cached activity, so its intervals are fetched again", async () => {
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`PUT ${PUT_URL("i555", true)}`]: answer(),
  });
  const client = await connect();
  await call(client, "get_activity_intervals", { id: "i555" });
  await call(client, "set_activity_intervals", { id: "i555", replace: true, intervals: [{ start_s: 100, end_s: 160 }] });
  await call(client, "get_activity_intervals", { id: "i555" });
  assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [
    `GET ${activityUrl(ME, "i555")}`,
    `GET ${STREAMS_URL("i555")}`,
    `PUT ${PUT_URL("i555", true)}`,
    `GET ${activityUrl(ME, "i555")}`,
  ]);
});

test("coach_set_activity_intervals writes a coached athlete's activity", async () => {
  const requests = fakeIntervals({
    [`GET ${activityUrl(COACHED, "i555")}`]: [{ ...ACTIVITY, icu_athlete_id: COACHED }],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`PUT ${PUT_URL("i555", true)}`]: answer(),
  });
  const result = await call(await connect(), "coach_set_activity_intervals", {
    athlete_id: COACHED, id: "i555", replace: true, intervals: [{ start_s: 100, end_s: 160 }],
  });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(requests.map(r => r.url), [activityUrl(COACHED, "i555"), STREAMS_URL("i555"), PUT_URL("i555", true)]);
});
