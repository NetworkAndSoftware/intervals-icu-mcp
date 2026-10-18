import { test } from "node:test";
import assert from "node:assert/strict";
import { API, call, COACHED, connect, fakeIntervals, ME } from "./helpers.mjs";

const eventUrl = (athlete, id) => `${API}/athlete/${athlete}/events/${id}`;

const STRENGTH = {
  id: 42, athlete_id: ME, category: "WORKOUT", start_date_local: "2026-10-20T07:30:00",
  name: "Strength A", type: "WeightTraining", description: "Squats, lunges",
  moving_time: 2700, time_target: null, icu_training_load: 35, load_target: 35, distance: null,
};

// The event as intervals.icu stores it, for its PUT route: each PUT changes what it sends and
// answers with the result. With rederive, a new description also changes type, duration and
// load whatever else the PUT sent, as "yoga 20'" in a strength workout's notes did
function stored(event, { rederive = false } = {}) {
  let state = { ...event };
  return (body) => (state = {
    ...state, ...body,
    ...(rederive && body.description != null && { type: "Yoga", moving_time: 1200, icu_training_load: null, load_target: null }),
  });
}

const puts = (requests) => requests.filter(r => r.method === "PUT").map(r => r.body);

test("update_event moves an event with start_date_local, keeping its time when only a date is given", async () => {
  const requests = fakeIntervals({
    [`GET ${eventUrl(ME, 42)}`]: STRENGTH,
    [`PUT ${eventUrl(ME, 42)}`]: stored(STRENGTH),
  });
  const client = await connect();
  for (const [start_date_local, expected] of [
    ["2026-10-22", "2026-10-22T07:30:00"],
    ["2026-10-22T06:15", "2026-10-22T06:15:00"],
    ["2026-10-22T18:05:00", "2026-10-22T18:05:00"],
    ["2026-10-22T00:00", "2026-10-22T00:00:00"],
  ]) {
    const result = await call(client, "update_event", { id: 42, start_date_local });
    assert.equal(result.isError, false, result.text);
    assert.equal(JSON.parse(result.text).start_date_local, expected);
  }
  assert.deepEqual(puts(requests), [
    { start_date_local: "2026-10-22T07:30:00" },
    { start_date_local: "2026-10-22T06:15:00" },
    { start_date_local: "2026-10-22T18:05:00" },
    { start_date_local: "2026-10-22T00:00:00" },
  ]);
});

test("update_event moves a multi-day event's end with start_date_local, as with start_date", async () => {
  const holiday = { id: 7, athlete_id: ME, category: "HOLIDAY", start_date_local: "2026-11-02T00:00:00", end_date_local: "2026-11-05T00:00:00" };
  const requests = fakeIntervals({
    [`GET ${eventUrl(ME, 7)}`]: holiday,
    [`PUT ${eventUrl(ME, 7)}`]: stored(holiday),
  });
  const result = await call(await connect(), "update_event", { id: 7, start_date_local: "2026-11-09" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(puts(requests), [{ start_date_local: "2026-11-09T00:00:00", end_date_local: "2026-11-12T00:00:00" }]);
});

test("update_event refuses start_date_local with start_date or start_time, or in another format", async () => {
  const requests = fakeIntervals({ [`GET ${eventUrl(ME, 42)}`]: STRENGTH });
  const client = await connect();
  for (const args of [
    { start_date_local: "2026-10-22", start_date: "2026-10-23" },
    { start_date_local: "2026-10-22", start_time: "08:00" },
    { start_date_local: "22/10/2026" },
    { start_date_local: "2026-10-22T7:30" },
    { start_date_local: "2026-10-22T07:30:00Z" },
  ]) {
    const result = await call(client, "update_event", { id: 42, ...args });
    assert.equal(result.isError, true, JSON.stringify(args));
  }
  assert.deepEqual(puts(requests), []);
});

test("update_event keeps type, duration and load when only the description changes", async () => {
  const requests = fakeIntervals({
    [`GET ${eventUrl(ME, 42)}`]: STRENGTH,
    [`PUT ${eventUrl(ME, 42)}`]: stored(STRENGTH, { rederive: true }),
  });
  const description = "Strength A\nSquats, lunges, then yoga 20'";
  const result = await call(await connect(), "update_event", { id: 42, description });
  assert.equal(result.isError, false, result.text);
  const kept = { type: "WeightTraining", moving_time: 2700, icu_training_load: 35, load_target: 35 };
  // Sent with the description, and again on their own because intervals.icu re-derived them anyway
  assert.deepEqual(puts(requests), [{ ...kept, description }, kept]);
  assert.deepEqual(JSON.parse(result.text), { ...STRENGTH, description });
});

test("update_event sends one PUT when intervals.icu keeps what it was sent", async () => {
  const requests = fakeIntervals({
    [`GET ${eventUrl(ME, 42)}`]: STRENGTH,
    [`PUT ${eventUrl(ME, 42)}`]: stored(STRENGTH),
  });
  const result = await call(await connect(), "update_event", { id: 42, name: "Strength B" });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(puts(requests), [{ type: "WeightTraining", moving_time: 2700, icu_training_load: 35, load_target: 35, name: "Strength B" }]);
});

test("update_event lets the fields passed with a new description change", async () => {
  const requests = fakeIntervals({
    [`GET ${eventUrl(ME, 42)}`]: STRENGTH,
    [`PUT ${eventUrl(ME, 42)}`]: stored(STRENGTH, { rederive: true }),
  });
  const args = { id: 42, description: "- 20m 50%", type: "Yoga", load_target: 10 };
  const result = await call(await connect(), "update_event", args);
  assert.equal(result.isError, false, result.text);
  // Only the duration wasn't passed, so only it is kept
  assert.deepEqual(puts(requests), [
    { moving_time: 2700, description: "- 20m 50%", type: "Yoga", load_target: 10, icu_training_load: 10 },
    { moving_time: 2700 },
  ]);
});

test("update_event sends no type, duration or load for other changes", async () => {
  const requests = fakeIntervals({
    [`GET ${eventUrl(ME, 42)}`]: STRENGTH,
    [`PUT ${eventUrl(ME, 42)}`]: stored(STRENGTH),
  });
  const result = await call(await connect(), "update_event", { id: 42, color: "red", tags: ["gym"] });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(puts(requests), [{ color: "red", tags: ["gym"] }]);
});

test("coach_update_event keeps a coached athlete's type, duration and load too", async () => {
  const theirs = { ...STRENGTH, athlete_id: COACHED };
  const requests = fakeIntervals({
    [`GET ${eventUrl(COACHED, 42)}`]: theirs,
    [`PUT ${eventUrl(COACHED, 42)}`]: stored(theirs, { rederive: true }),
  });
  const result = await call(await connect(), "coach_update_event", { athlete_id: COACHED, id: 42, description: "yoga 20'", start_date_local: "2026-10-21" });
  assert.equal(result.isError, false, result.text);
  const kept = { type: "WeightTraining", moving_time: 2700, icu_training_load: 35, load_target: 35 };
  assert.deepEqual(puts(requests), [{ ...kept, description: "yoga 20'", start_date_local: "2026-10-21T07:30:00" }, kept]);
  assert.ok(requests.every(r => r.url === eventUrl(COACHED, 42)));
});
