import express, { type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { IntervalsClient } from "./api.js";
import { MemoryCache } from "./cache.js";
import { UsersOAuthProvider } from "./oauth.js";
import { createMcpServer } from "./server.js";

// A person who can sign in, and the intervals.icu account their tools act on
export type User = { name: string; password: string; athleteId: string; apiKey: string };

export type HttpConfig = {
  users: User[];
  signingSecret: string;
  redirectUris: string[];
  // Public origin, e.g. http://localhost:3000. When unset, it's taken from the Host header,
  // which is only trusted for Lambda function URLs (AWS routes on it, so it can't be spoofed)
  publicUrl?: string;
};

const LAMBDA_URL_HOST = /^[a-z0-9]+\.lambda-url\.[a-z0-9-]+\.on\.aws$/;

export function redirectUrisFromEnv(value: string | undefined): string[] {
  const uris = (value ?? "").split(",").map((uri) => uri.trim()).filter(Boolean);
  return uris.length > 0 ? uris : ["https://claude.ai/api/mcp/auth_callback"];
}

// Parses the USERS secret (a JSON array, written by scripts/users.mjs)
export function parseUsers(json: string): User[] {
  const users = JSON.parse(json) as User[];
  if (!Array.isArray(users) || users.length === 0) throw new Error("USERS must be a non-empty JSON array");
  const names = new Set<string>();
  for (const user of users) {
    if (!/^[a-z0-9_-]+$/.test(user?.name ?? "")) throw new Error(`Invalid user name: ${JSON.stringify(user?.name)}`);
    if (!user.password || !user.athleteId || !user.apiKey) throw new Error(`User ${user.name} is missing fields`);
    if (names.has(user.name)) throw new Error(`Duplicate user: ${user.name}`);
    names.add(user.name);
  }
  return users;
}

export function createHttpApp(config: HttpConfig): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // One hop: Lambda's function URL front end (or none locally), for the rate limiters' client IP
  app.set("trust proxy", 1);

  // The OAuth metadata embeds absolute URLs, so the routes are built once the origin is known
  let routes: { origin: string; router: express.Router } | undefined;
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    const origin = config.publicUrl ?? (LAMBDA_URL_HOST.test(host) ? `https://${host}` : undefined);
    if (!origin) {
      res.status(421).send("Unrecognized host; set PUBLIC_URL");
      return;
    }
    routes ??= { origin, router: createRoutes(config, origin) };
    if (routes.origin !== origin) {
      res.status(421).send("Misdirected request");
      return;
    }
    routes.router(req, res, next);
  });

  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = typeof error?.status === "number" ? error.status : 500;
    if (status >= 500) console.error("Request failed:", error);
    res.status(status).json({ error: status >= 500 ? "server_error" : "invalid_request" });
  };
  app.use(onError);

  return app;
}

function createRoutes(config: HttpConfig, origin: string): express.Router {
  const router = express.Router();
  const mcpUrl = new URL("/mcp", origin);
  const provider = new UsersOAuthProvider({
    users: config.users,
    signingSecret: config.signingSecret,
    redirectUris: config.redirectUris,
    resourceUrl: mcpUrl,
  });
  // A cache per athlete, not a shared one: cache keys don't include the athlete ID
  const athletes = new Map(
    config.users.map((user) => [
      user.name,
      { client: new IntervalsClient(user.athleteId, user.apiKey), cache: new MemoryCache() },
    ])
  );

  // The rate limiters warn when created inside a request handler, which these are, once per
  // instance, because the origin isn't known until the first request
  const rateLimitOptions = { validate: { creationStack: false } };
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(origin),
      resourceServerUrl: mcpUrl,
      resourceName: "intervals.icu",
      authorizationOptions: { rateLimit: rateLimitOptions },
      tokenOptions: { rateLimit: rateLimitOptions },
      clientRegistrationOptions: { rateLimit: rateLimitOptions },
    })
  );

  router.post(
    "/login",
    // Per instance only on Lambda, so the password's length is the real defence
    rateLimit({ ...rateLimitOptions, windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }),
    express.urlencoded({ extended: false }),
    (req, res, next) => provider.handleLogin(req, res).catch(next)
  );

  const requireAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  router.post("/mcp", requireAuth, express.json({ limit: "1mb" }), async (req, res) => {
    // The provider only accepts tokens of current users, so this always resolves
    const athlete = athletes.get(String(req.auth?.extra?.user))!;
    // Stateless: a fresh server and transport per request, so any Lambda instance can serve any call
    const server = createMcpServer(athlete.client, athlete.cache, { remote: true });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // No sessions, so there's no SSE stream to GET and nothing to DELETE
  router.all("/mcp", requireAuth, (_req, res) => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return router;
}
