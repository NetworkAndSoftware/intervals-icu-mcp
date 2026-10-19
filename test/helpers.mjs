// Shared by the tests, which run against the build in dist/ (npm test builds it first)
import { afterEach } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { IntervalsClient } from "../dist/api.js";
import { MemoryCache } from "../dist/cache.js";
import { createMcpServer } from "../dist/server.js";

export const API = "https://intervals.icu/api/v1";
export const ME = "i100";
export const COACHED = "i200";
export const OTHER = "i300";
export const KEY = "test-key";
export const AUTH = "Basic " + Buffer.from(`API_KEY:${KEY}`).toString("base64");

// Stands in for intervals.icu: answers the routes a test lists ("METHOD url": JSON body, or a
// function of the request's JSON body that returns it) and records every request, with its
// body if it has one. Anything else gets a 405, as intervals.icu answers a method a path
// doesn't support. Nothing reaches the network, so no real activity is ever deleted.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

export function fakeIntervals(routes) {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const request = { method, url: String(url), auth: init.headers?.Authorization };
    if (typeof init.body === "string") request.body = JSON.parse(init.body);
    requests.push(request);
    const route = routes[`${method} ${url}`];
    const body = typeof route === "function" ? route(request.body) : route;
    if (body === undefined) {
      return new Response(JSON.stringify({ status: 405, error: "Method Not Allowed" }), { status: 405, statusText: "Method Not Allowed" });
    }
    return Response.json(body);
  };
  return requests;
}

// The MCP server as Lambda runs it, with a client connected to it in memory
export async function connect() {
  const server = createMcpServer(new IntervalsClient(ME, KEY), new MemoryCache(), { remote: true });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError ?? false, text: result.content[0].text };
}

// GET of an activity, as the owner check and get_activity send it
export const activityUrl = (athlete, id) => `${API}/athlete/${athlete}/activities/${id}?intervals=true`;

// The streams the window and interval tools fetch
export const STREAMS_URL = (id) => `${API}/activity/${id}/streams?types=distance%2Cheartrate%2Clatlng%2Ctime%2Cwatts`;

// A made-up ride: three 3 km laps of a circle at 10 m/s, one sample a second, with a 100 s
// stop (no samples, as with auto-pause) after the second lap.
//   0–99 s 200 W, 100–159 s 400 W, 160–599 s 150 W, stop, 700–999 s 300 W
// HR is 120 bpm before the stop and 150 after, with two dropouts.
const LAP_M = 3000;
const RADIUS_M = LAP_M / (2 * Math.PI);
export const M_PER_DEGREE = 6_371_008.8 * Math.PI / 180;
const CENTER = [48, -122];
export const at = (meters) => {
  const angle = 2 * Math.PI * meters / LAP_M;
  return [
    CENTER[0] + RADIUS_M * Math.sin(angle) / M_PER_DEGREE,
    CENTER[1] + RADIUS_M * Math.cos(angle) / (M_PER_DEGREE * Math.cos(CENTER[0] * Math.PI / 180)),
  ];
};

export function ride() {
  const time = [], watts = [], heartrate = [], distance = [], lat = [], lng = [];
  for (let k = 0; k < 900; k++) {
    const t = k < 600 ? k : k + 100;
    time.push(t);
    watts.push(t < 100 ? 200 : t < 160 ? 400 : t < 600 ? 150 : 300);
    heartrate.push(k === 50 || k === 650 ? null : t < 600 ? 120 : 150);
    distance.push(10 * k);
    const [la, ln] = at(10 * k);
    lat.push(la);
    lng.push(ln);
  }
  return [
    { type: "time", data: time },
    { type: "watts", data: watts },
    { type: "heartrate", data: heartrate },
    { type: "distance", data: distance },
    { type: "latlng", data: lat, data2: lng },
  ];
}
