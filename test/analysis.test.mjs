import { test } from "node:test";
import assert from "node:assert/strict";
import { activityUrl, at, AUTH, call, COACHED, connect, fakeIntervals, M_PER_DEGREE, ME, ride, STREAMS_URL } from "./helpers.mjs";

const CP = 250;
const W_PRIME = 20000;
const FTP = 280;

const ACTIVITY = { id: "i555", icu_athlete_id: ME, name: "Rabbit Ride", start_date_local: "2026-10-18T07:10:00", icu_ftp: FTP };

// The differential model's W′ balance, worked out by hand for the made-up ride
const recover = (wbal, watts, seconds) => W_PRIME - (W_PRIME - wbal) * Math.exp(-(CP - watts) * seconds / W_PRIME);
const WBAL_160 = W_PRIME - (400 - CP) * 60;            // 11000 after the minute at 400 W
const WBAL_500 = recover(WBAL_160, 150, 340);
const WBAL_600 = recover(WBAL_160, 150, 440);           // at the stop
const WBAL_700 = recover(WBAL_600, 0, 100);            // after it
const WBAL_END = WBAL_700 - (300 - CP) * 300;

async function analyze(windows, more = {}) {
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
  });
  const result = await call(await connect(), "analyze_activity_window", { id: "i555", cp: CP, w_prime: W_PRIME, windows, ...more });
  assert.equal(result.isError, false, result.text);
  return { requests, data: JSON.parse(result.text) };
}

test("analyze_activity_window: a window by time", async () => {
  const { data, requests } = await analyze([{ label: "Colony", start_s: 100, end_s: 160 }]);
  assert.deepEqual(data, {
    activity: { id: "i555", name: "Rabbit Ride", start_date_local: "2026-10-18T07:10:00" },
    cp_w: CP,
    w_prime_j: W_PRIME,
    threshold_w: FTP,
    threshold_source: "activity FTP",
    wbal_model: "Skiba differential (Skiba et al. 2015), from the ride start; stops count as 0 W",
    windows: [{
      label: "Colony",
      start_time_s: 100, end_time_s: 160, duration_s: 60,
      start_distance_m: 1000, end_distance_m: 1600, distance_m: 600,
      avg_power_w: 400, np_w: 400, avg_hr: 120, max_hr: 120,
      kj_above_threshold: 7.2, kj_above_cp: 9,
      wbal_start_j: W_PRIME, wbal_end_j: WBAL_160, wbal_min_j: WBAL_160,
      ride_kj_above_threshold_before: 0,
    }],
  });
  assert.deepEqual(requests, [
    { method: "GET", url: activityUrl(ME, "i555"), auth: AUTH },
    { method: "GET", url: STREAMS_URL("i555"), auth: AUTH },
  ]);
});

test("analyze_activity_window: W′ balance runs from the ride start, recovering during stops", async () => {
  const { data } = await analyze([
    { label: "to 500 s", start_s: 0, end_s: 500 },
    { label: "after the stop", start_s: 650, end_s: 5000 },
  ]);
  const [first, second] = data.windows;
  assert.equal(first.wbal_start_j, W_PRIME);
  assert.equal(first.wbal_min_j, WBAL_160);
  assert.equal(first.wbal_end_j, Math.round(WBAL_500));
  assert.equal(first.kj_above_threshold, 7.2);

  // Starts at the first sample after the stop and ends with the ride
  assert.equal(second.start_time_s, 700);
  assert.equal(second.end_time_s, 1000);
  assert.equal(second.wbal_start_j, Math.round(WBAL_700));
  assert.equal(second.wbal_end_j, Math.round(WBAL_END));
  assert.equal(second.wbal_min_j, Math.round(WBAL_END));
  assert.equal(second.kj_above_threshold, 6);
  assert.equal(second.kj_above_cp, 15);
  assert.equal(second.ride_kj_above_threshold_before, 7.2);
  assert.equal(second.avg_power_w, 300);
  assert.equal(second.avg_hr, 150);
});

test("analyze_activity_window: NP over the window, and none under 30 s", async () => {
  const { data } = await analyze([{ start_s: 0, end_s: 160 }, { start_s: 100, end_s: 120 }]);
  // Straight from the definition: 30 s rolling averages, 4th power mean, 4th root
  const watts = Array.from({ length: 160 }, (_, t) => (t < 100 ? 200 : 400));
  const rolling = watts.slice(29).map((_, i) => watts.slice(i, i + 30).reduce((a, b) => a + b) / 30);
  const np = (rolling.reduce((a, p) => a + p ** 4, 0) / rolling.length) ** 0.25;
  assert.equal(data.windows[0].np_w, Math.round(np));
  assert.equal(data.windows[0].avg_power_w, Math.round((100 * 200 + 60 * 400) / 160));
  assert.equal(data.windows[1].np_w, undefined);
  assert.equal(data.windows[1].avg_power_w, 400);
});

test("analyze_activity_window: a window by distance matches the same window by time", async () => {
  const { data } = await analyze([{ start_m: 1000, end_m: 1600 }, { start_s: 100, end_s: 160 }]);
  assert.deepEqual(data.windows[0], data.windows[1]);
});

test("analyze_activity_window: windows by place, a loop's end at its start, and after a time", async () => {
  const { data } = await analyze([
    { label: "quarter to half", start_point: at(750), end_point: at(1500) },
    { label: "lap", start_point: at(0), end_point: at(0) },
    { label: "second lap", start_point: at(0), end_point: at(0), after_s: 200 },
    // 20 m off the track still matches, at the nearest sample
    { label: "near", start_point: at(750).map((v, i) => v + (i === 0 ? 20 / M_PER_DEGREE : 0)), end_s: 150 },
  ]);
  const [quarter, lap, secondLap, near] = data.windows;
  assert.equal(quarter.start_time_s, 75);
  assert.equal(quarter.end_time_s, 150);
  assert.equal(quarter.start_match_m, 0);
  assert.equal(quarter.end_match_m, 0);
  assert.equal(quarter.wbal_start_j, W_PRIME);
  assert.equal(quarter.wbal_end_j, W_PRIME - 150 * 50);

  assert.equal(lap.start_time_s, 0);
  assert.equal(lap.end_time_s, 300);
  assert.equal(lap.distance_m, 3000);

  // The second pass of the start point, then the next one, after the stop
  assert.equal(secondLap.start_time_s, 300);
  assert.equal(secondLap.end_time_s, 700);
  assert.equal(secondLap.start_distance_m, 3000);
  assert.equal(secondLap.end_distance_m, 6000);
  assert.equal(secondLap.wbal_end_j, Math.round(WBAL_700));

  assert.equal(near.start_time_s, 75);
  assert.ok(Math.abs(near.start_match_m - 20) < 1, `matched ${near.start_match_m} m away`);
});

test("analyze_activity_window: a window it can't place gets an error, the others their numbers", async () => {
  const { data } = await analyze([
    { label: "nowhere", start_point: [47, -121], end_s: 100 },
    { label: "no end", start_point: at(750), end_point: [47, -121] },
    { label: "two starts", start_s: 0, start_m: 0, end_s: 10 },
    { label: "no start", end_s: 10 },
    { label: "backwards", start_s: 200, end_s: 100 },
    { label: "past the end", start_s: 2000, end_s: 3000 },
    { label: "ok", start_s: 0, end_s: 10 },
  ]);
  assert.deepEqual(data.windows.slice(0, 6), [
    { label: "nowhere", error: "No pass within 30 m of start_point" },
    { label: "no end", error: "No pass within 30 m of end_point after the start" },
    { label: "two starts", error: "Give exactly one of start_s, start_m, start_point" },
    { label: "no start", error: "Give exactly one of start_s, start_m, start_point" },
    { label: "backwards", error: "The window ends before it starts" },
    { label: "past the end", error: "The ride ends before the window starts" },
  ]);
  assert.equal(data.windows[6].duration_s, 10);
});

test("analyze_activity_window: threshold_w replaces the activity's FTP", async () => {
  const { data } = await analyze([{ start_s: 100, end_s: 160 }], { threshold_w: 300 });
  assert.equal(data.threshold_w, 300);
  assert.equal(data.threshold_source, "threshold_w");
  assert.equal(data.windows[0].kj_above_threshold, 6);
});

test("analyze_activity_window fetches the streams once, and refuses another account's activity", async () => {
  const requests = fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [ACTIVITY],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
    [`GET ${activityUrl(ME, "i556")}`]: [{ ...ACTIVITY, id: "i556", icu_athlete_id: COACHED }],
  });
  const client = await connect();
  const args = { cp: CP, w_prime: W_PRIME, windows: [{ start_s: 0, end_s: 10 }] };
  for (let i = 0; i < 2; i++) assert.equal((await call(client, "analyze_activity_window", { id: "i555", ...args })).isError, false);
  const refused = await call(client, "analyze_activity_window", { id: "i556", ...args });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /belongs to athlete i200/);
  assert.deepEqual(requests.map(r => r.url), [activityUrl(ME, "i555"), STREAMS_URL("i555"), activityUrl(ME, "i556")]);
});

test("coach_analyze_activity_window works on a coached athlete's activity", async () => {
  const requests = fakeIntervals({
    [`GET ${activityUrl(COACHED, "i555")}`]: [{ ...ACTIVITY, icu_athlete_id: COACHED }],
    [`GET ${STREAMS_URL("i555")}`]: ride(),
  });
  const result = await call(await connect(), "coach_analyze_activity_window", {
    athlete_id: COACHED, id: "i555", cp: CP, w_prime: W_PRIME, windows: [{ start_s: 100, end_s: 160 }],
  });
  assert.equal(result.isError, false, result.text);
  assert.equal(JSON.parse(result.text).windows[0].wbal_end_j, WBAL_160);
  assert.deepEqual(requests.map(r => r.url), [activityUrl(COACHED, "i555"), STREAMS_URL("i555")]);
});

test("analyze_activity_window needs power, and an FTP or threshold_w", async () => {
  fakeIntervals({
    [`GET ${activityUrl(ME, "i555")}`]: [{ ...ACTIVITY, icu_ftp: null }],
    [`GET ${STREAMS_URL("i555")}`]: ride().filter(s => s.type !== "watts"),
  });
  const client = await connect();
  const args = { id: "i555", cp: CP, w_prime: W_PRIME, windows: [{ start_s: 0, end_s: 10 }] };
  const noFtp = await call(client, "analyze_activity_window", args);
  assert.equal(noFtp.isError, true);
  assert.match(noFtp.text, /no FTP: pass threshold_w/);
  const noPower = await call(client, "analyze_activity_window", { ...args, threshold_w: 280 });
  assert.equal(noPower.isError, true);
  assert.match(noPower.text, /no power data/);
});
