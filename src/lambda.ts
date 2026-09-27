import type { IncomingMessage } from "node:http";
import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import serverless from "serverless-http";
import { createHttpApp, parseUsers, redirectUrisFromEnv } from "./http.js";

// AWS Lambda entry point, bundled by scripts/build-lambda.mjs and deployed with template.yaml.
// Secrets are SecureString parameters in SSM Parameter Store (managed with scripts/users.mjs),
// read once per cold start, so they never appear in the function's configuration.

const SECRET_NAMES = ["USERS", "MCP_SIGNING_SECRET"] as const;
type SecretName = (typeof SECRET_NAMES)[number];

const prefix = process.env.SSM_PREFIX ?? "/intervals-icu-mcp";
const { Parameters = [], InvalidParameters = [] } = await new SSMClient({}).send(
  new GetParametersCommand({ Names: SECRET_NAMES.map((name) => `${prefix}/${name}`), WithDecryption: true })
);
if (InvalidParameters.length > 0) {
  throw new Error(`Missing SSM parameters: ${InvalidParameters.join(", ")}. Add a user with npm run users -- add.`);
}
const secrets = Object.fromEntries(
  Parameters.map((parameter) => [parameter.Name!.slice(prefix.length + 1), parameter.Value!])
) as Record<SecretName, string>;

const app = createHttpApp({
  users: parseUsers(secrets.USERS),
  signingSecret: secrets.MCP_SIGNING_SECRET,
  redirectUris: redirectUrisFromEnv(process.env.OAUTH_REDIRECT_URIS),
  publicUrl: process.env.PUBLIC_URL || undefined,
});

export const handler = serverless(app, {
  // The MCP SDK's HTTP transport reads rawHeaders (via @hono/node-server), which serverless-http leaves empty
  request(req: IncomingMessage) {
    req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [String(value)]).flatMap((v) => [name, v])
    );
  },
});
