import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

// Minimal OAuth server for claude.ai custom connectors, which only support OAuth or no auth.
// Each user signs in with a name and password on the page served by authorize().
//
// Everything is stateless so it runs on Lambda without a database: client IDs, codes and
// tokens are HMAC-signed claims. The trade-off is that a single token can't be revoked:
// changing a user's password signs out all of that user's clients, and changing
// MCP_SIGNING_SECRET signs out everyone.

const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour
const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60; // 90 days, renewed on every refresh
// Codes can't be marked as used without storage, so they're short-lived and PKCE-bound instead
const CODE_TTL = 2 * 60;
const LOGIN_FORM_TTL = 10 * 60;

type ClientClaims = { typ: "client"; r: string[]; m: string };
type LoginClaims = { typ: "login"; cid: string; ru: string; cc: string; st?: string; sc: string[]; exp: number };
// sub is the user's name; pv fingerprints their password, so changing it invalidates their tokens
type CodeClaims = { typ: "code"; cid: string; ru: string; cc: string; sc: string[]; sub: string; pv: string; exp: number };
type TokenClaims = { typ: "access" | "refresh"; cid: string; sc: string[]; sub: string; pv: string; exp: number };

export type OAuthUser = { name: string; password: string };

const now = () => Math.floor(Date.now() / 1000);
const sha256 = (value: string) => createHash("sha256").update(value).digest();

class Signer {
  constructor(private key: Buffer) {}

  sign(claims: object): string {
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${body}.${this.mac(body).toString("base64url")}`;
  }

  verify<T extends { typ: string; exp?: number }>(token: string, typ: T["typ"]): T | undefined {
    const [body, mac, rest] = token.split(".");
    if (!body || !mac || rest !== undefined) return undefined;
    const given = Buffer.from(mac, "base64url");
    const expected = this.mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    if (claims.typ !== typ) return undefined;
    if (claims.exp !== undefined && claims.exp < now()) return undefined;
    return claims;
  }

  mac(value: string): Buffer {
    return createHmac("sha256", this.key).update(value).digest();
  }
}

export class UsersOAuthProvider implements OAuthServerProvider {
  private signer: Signer;
  private users = new Map<string, { passwordDigest: Buffer; pv: string }>();
  // Compared against when the name is unknown, so timing doesn't reveal which names exist
  private unknownUserDigest = sha256(randomBytes(32).toString("hex"));

  constructor(
    private options: {
      users: OAuthUser[];
      signingSecret: string;
      // Redirect URIs a client may register, e.g. claude.ai's connector callback
      redirectUris: string[];
      // The MCP endpoint these tokens are for
      resourceUrl: URL;
    }
  ) {
    if (options.signingSecret.length < 32) throw new Error("MCP_SIGNING_SECRET must be at least 32 characters");
    this.signer = new Signer(Buffer.from(options.signingSecret));
    for (const { name, password } of options.users) {
      if (password.length < 16) throw new Error(`Password for ${name} must be at least 16 characters`);
      this.users.set(name, {
        passwordDigest: sha256(password),
        pv: this.signer.mac(`password:${name}:${password}`).subarray(0, 12).toString("base64url"),
      });
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => {
        const disallowed = client.redirect_uris.filter((uri) => !this.options.redirectUris.includes(uri));
        if (disallowed.length > 0) {
          throw new InvalidClientMetadataError(`redirect_uri not allowed: ${disallowed.join(", ")}`);
        }
        const method = client.token_endpoint_auth_method ?? (client.client_secret ? "client_secret_post" : "none");
        const clientId = this.signer.sign({ typ: "client", r: client.redirect_uris, m: method } satisfies ClientClaims);
        return { ...client, ...this.getClient(clientId)!, client_id_issued_at: now() };
      },
    };
  }

  private getClient(clientId: string): OAuthClientInformationFull | undefined {
    const claims = this.signer.verify<ClientClaims>(clientId, "client");
    if (!claims) return undefined;
    return {
      client_id: clientId,
      redirect_uris: claims.r.filter((uri) => this.options.redirectUris.includes(uri)),
      token_endpoint_auth_method: claims.m,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // Confidential clients get a secret derived from their ID, so it needn't be stored
      ...(claims.m === "none"
        ? {}
        : { client_secret: this.signer.mac(`secret:${clientId}`).toString("base64url"), client_secret_expires_at: 0 }),
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const request = this.signer.sign({
      typ: "login",
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [],
      exp: now() + LOGIN_FORM_TTL,
    } satisfies LoginClaims);
    this.sendLoginPage(res, request, params.redirectUri);
  }

  // POST /login, submitted by the page from authorize()
  async handleLogin(req: Request, res: Response): Promise<void> {
    const request = typeof req.body?.request === "string" ? req.body.request : "";
    const claims = this.signer.verify<LoginClaims>(request, "login");
    if (!claims || !this.getClient(claims.cid)?.redirect_uris.includes(claims.ru)) {
      this.sendPage(res.status(400), "<p>This sign-in link has expired. Start the connection again from Claude.</p>");
      return;
    }

    const name = typeof req.body.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const user = this.users.get(name);
    const passwordMatches = timingSafeEqual(sha256(password), user?.passwordDigest ?? this.unknownUserDigest);
    if (!user || !passwordMatches) {
      await new Promise((resolve) => setTimeout(resolve, 500 + randomInt(500)));
      this.sendLoginPage(res.status(401), request, claims.ru, "Wrong name or password.", name);
      return;
    }

    const code = this.signer.sign({
      typ: "code",
      cid: claims.cid,
      ru: claims.ru,
      cc: claims.cc,
      sc: claims.sc,
      sub: name,
      pv: user.pv,
      exp: now() + CODE_TTL,
    } satisfies CodeClaims);
    const target = new URL(claims.ru);
    target.searchParams.set("code", code);
    if (claims.st !== undefined) target.searchParams.set("state", claims.st);
    res.redirect(302, target.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.verifyCode(client, authorizationCode).cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = this.verifyCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== claims.ru) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);
    return this.issueTokens(client.client_id, claims);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = this.signer.verify<TokenClaims>(refreshToken, "refresh");
    if (!claims || claims.cid !== client.client_id || !this.isCurrentUser(claims)) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    this.checkResource(resource);
    return this.issueTokens(client.client_id, claims);
  }

  // AuthInfo.extra.user is the signed-in user's name
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = this.signer.verify<TokenClaims>(token, "access");
    if (!claims || !this.isCurrentUser(claims)) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token,
      clientId: claims.cid,
      scopes: claims.sc,
      expiresAt: claims.exp,
      resource: this.options.resourceUrl,
      extra: { user: claims.sub },
    };
  }

  private verifyCode(client: OAuthClientInformationFull, code: string): CodeClaims {
    const claims = this.signer.verify<CodeClaims>(code, "code");
    if (!claims || claims.cid !== client.client_id || !this.isCurrentUser(claims)) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return claims;
  }

  // False once the user is removed or their password changes
  private isCurrentUser(claims: { sub: string; pv: string }): boolean {
    return this.users.get(claims.sub)?.pv === claims.pv;
  }

  private checkResource(resource: URL | undefined) {
    if (resource && resource.href !== this.options.resourceUrl.href) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.options.resourceUrl.href}`);
    }
  }

  private issueTokens(clientId: string, { sc, sub, pv }: { sc: string[]; sub: string; pv: string }): OAuthTokens {
    const issuedAt = now();
    const claims = { cid: clientId, sc, sub, pv };
    return {
      access_token: this.signer.sign({ typ: "access", ...claims, exp: issuedAt + ACCESS_TOKEN_TTL } satisfies TokenClaims),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: this.signer.sign({ typ: "refresh", ...claims, exp: issuedAt + REFRESH_TOKEN_TTL } satisfies TokenClaims),
      ...(sc.length > 0 ? { scope: sc.join(" ") } : {}),
    };
  }

  private sendLoginPage(res: Response, request: string, redirectUri: string, error?: string, name = "") {
    this.sendPage(
      res,
      `<p>Connect <strong>${escapeHtml(new URL(redirectUri).host)}</strong> to your intervals.icu data.</p>
      <form method="post" action="/login">
        <input type="hidden" name="request" value="${escapeHtml(request)}">
        <label for="username">Name</label>
        <input id="username" name="username" type="text" value="${escapeHtml(name)}" autocomplete="username" autocapitalize="none" spellcheck="false" required${name ? "" : " autofocus"}>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required${name ? " autofocus" : ""}>
        ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
        <button type="submit">Allow access</button>
      </form>`
    );
  }

  private sendPage(res: Response, body: string) {
    // The login form redirects to the client, and Chrome applies form-action to that redirect too
    const formTargets = [...new Set(this.options.redirectUris.map((uri) => new URL(uri).origin))];
    res
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${formTargets.join(" ")}; frame-ancestors 'none'; base-uri 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      })
      .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>intervals.icu MCP sign-in</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --accent: #c2410c; --error: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #22221f; --text: #ecece8; --muted: #a3a39c; --accent: #fb923c; --error: #f87171; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(360px, calc(100vw - 32px)); background: var(--card); border-radius: 12px; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  label { display: block; margin-top: 16px; font-weight: 600; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px 12px; font: inherit; border: 1px solid var(--muted); border-radius: 8px; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 16px; padding: 12px; font: inherit; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: #fff; }
  .error { color: var(--error); margin: 8px 0 0; }
</style>
</head>
<body><main><h1>intervals.icu MCP</h1>${body}</main></body>
</html>`);
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
