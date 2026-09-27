import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IntervalsClient } from "./api.js";
import { createHttpApp, parseUsers, redirectUrisFromEnv } from "./http.js";
import { createMcpServer } from "./server.js";
import { SqliteCache } from "./sqlite-cache.js";

const athleteId = process.env.INTERVALS_ATHLETE_ID;
const apiKey = process.env.INTERVALS_API_KEY;

if (!athleteId || !apiKey) {
  console.error(
    "Missing INTERVALS_ATHLETE_ID or INTERVALS_API_KEY in environment. " +
      "Copy .env.example to .env and fill in your credentials."
  );
  process.exit(1);
}

if (process.argv.includes("--http")) {
  // Local run of the remote setup that Lambda uses (src/lambda.ts), for testing the OAuth flow.
  // Signs in as MCP_USERNAME/MCP_PASSWORD with the .env athlete, or MCP_USERS (same JSON as Lambda).
  const password = process.env.MCP_PASSWORD;
  const signingSecret = process.env.MCP_SIGNING_SECRET;
  if ((!password && !process.env.MCP_USERS) || !signingSecret) {
    console.error("HTTP mode needs MCP_PASSWORD (or MCP_USERS) and MCP_SIGNING_SECRET in the environment.");
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 3000);
  const app = createHttpApp({
    users: process.env.MCP_USERS
      ? parseUsers(process.env.MCP_USERS)
      : [{ name: process.env.MCP_USERNAME ?? "me", password: password!, athleteId, apiKey }],
    signingSecret,
    redirectUris: redirectUrisFromEnv(process.env.OAUTH_REDIRECT_URIS),
    publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
  });
  app.listen(port, () => console.error(`intervals-icu MCP server listening on http://localhost:${port}/mcp`));
} else {
  const server = createMcpServer(new IntervalsClient(athleteId, apiKey), new SqliteCache());
  await server.connect(new StdioServerTransport());
  console.error("intervals-icu MCP server running on stdio");
}
