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
