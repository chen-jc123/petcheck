// OAuth 2.1 for Alexa+ MCP add-ons, built into PetCheck (no extra infrastructure).
//
// Alexa+ requires two tiers (developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html):
//   Tier 1  client_credentials            → scope mcp:service  (service-level: tools/list, health; NO household data)
//   Tier 2  authorization_code + PKCE S256 → scope mcp:tools     (user-level: tool calls for the linked household)
//
// Endpoints (same host as /mcp):
//   GET  /.well-known/oauth-authorization-server   authorization server metadata (RFC 8414)
//   GET  /.well-known/oauth-protected-resource      protected resource metadata (RFC 9728)
//   GET  /oauth/authorize                           "Link your PetCheck household" page
//   POST /oauth/authorize                           household key check → redirect with ?code=…&state=…
//   POST /oauth/token                               client_credentials | authorization_code | refresh_token
//
// Tokens are compact HMAC-SHA256 signed JWTs, so nothing has to be stored: authorization
// codes (2 min), access tokens (1 h) and refresh tokens (90 days) are all self-contained.
// No dynamic client registration (Alexa+ doesn't use it): one client configured by env vars.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? "";
const SIGNING_KEY = process.env.OAUTH_SIGNING_KEY ?? "";
const HOUSEHOLD_KEY = process.env.API_KEY ?? "";
const HOUSEHOLD_ID = process.env.HOUSEHOLD_ID ?? "demo";

export const ACCESS_TTL_S = 3600;
const CODE_TTL_S = 120;
const REFRESH_TTL_S = 90 * 24 * 3600;

export const SCOPES = ["mcp:service", "mcp:tools", "mcp:resources"] as const;

/** Redirect URIs allowed for the authorization code flow: Amazon/Alexa hosts, plus any in OAUTH_REDIRECT_URIS. */
const EXTRA_REDIRECTS = (process.env.OAUTH_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const AMAZON_REDIRECT = /^https:\/\/([a-z0-9-]+\.)*(amazon\.(com|ca|co\.uk|de|fr|it|es|co\.jp|com\.au|com\.br|com\.mx|in)|amazonalexa\.com)\/[^\s]*$/i;

export function oauthEnabled(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET && SIGNING_KEY);
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ---------------------------------------------------------------------------
// Signed tokens
// ---------------------------------------------------------------------------

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function sign(payload: Record<string, unknown>, key = SIGNING_KEY): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", key).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

export function verify(token: string, key = SIGNING_KEY): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !key) return null;
  const expected = createHmac("sha256", key).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

const nowS = () => Math.floor(Date.now() / 1000);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Bearer token check used by /mcp
// ---------------------------------------------------------------------------

export interface AuthContext {
  kind: "api-key" | "service" | "user";
  scopes: string[];
  household?: string;
}

/**
 * Who is calling /mcp? Accepts the household API key (household page, simulated Alexa+,
 * Inspector) or an OAuth access token issued by this server for this resource.
 */
export function authenticate(authorization: string | undefined, xApiKey: string | undefined, resource: string): AuthContext | null {
  const bearer = authorization?.replace(/^Bearer\s+/i, "").trim();
  // Local development: no household key configured means no auth (same as before OAuth existed).
  // Deployments always set API_KEY, so this never applies on Lambda.
  if (!HOUSEHOLD_KEY && !oauthEnabled()) {
    return { kind: "api-key", scopes: ["mcp:service", "mcp:tools", "mcp:resources"], household: HOUSEHOLD_ID };
  }
  if (HOUSEHOLD_KEY && ((bearer && safeEqual(bearer, HOUSEHOLD_KEY)) || (xApiKey && safeEqual(xApiKey, HOUSEHOLD_KEY)))) {
    return { kind: "api-key", scopes: ["mcp:service", "mcp:tools", "mcp:resources"], household: HOUSEHOLD_ID };
  }
  if (!bearer || !oauthEnabled()) return null;
  const p = verify(bearer);
  if (!p || p.typ !== "access" || p.aud !== resource) return null;
  const scopes = String(p.scope ?? "").split(" ").filter(Boolean);
  return p.sub ? { kind: "user", scopes, household: String(p.sub) } : { kind: "service", scopes };
}

/** JSON-RPC methods a service-level (mcp:service) token may use: discovery only, no household data. */
export const SERVICE_METHODS = new Set(["initialize", "notifications/initialized", "ping", "tools/list"]);

/**
 * Decide whether an authenticated caller may send this JSON-RPC body to /mcp.
 * Returns null when allowed, or an HTTP status + JSON body to send back.
 * Unauthenticated → 401 with no WWW-Authenticate header (as Alexa+ requires).
 * Service token calling a household tool → 403 insufficient_scope (RFC 6750 §3.1).
 */
export function mcpAccessError(auth: AuthContext | null, body: unknown): { status: number; body: unknown } | null {
  if (!auth) return { status: 401, body: { jsonrpc: "2.0", error: { code: -32001, message: "Missing or invalid credentials." }, id: null } };
  if (auth.kind !== "service") return null;
  const msgs = Array.isArray(body) ? body : [body];
  const blocked = msgs.find((m) => !SERVICE_METHODS.has(String((m as { method?: string })?.method ?? "")));
  if (!blocked) return null;
  return {
    status: 403,
    body: {
      jsonrpc: "2.0",
      error: { code: -32003, message: "insufficient_scope: link your PetCheck household (mcp:tools) to use this tool." },
      id: (blocked as { id?: unknown })?.id ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const json = (status: number, body: unknown, extra: Record<string, string> = {}): HttpResult => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...extra },
  body: JSON.stringify(body),
});

/** RFC 6749 §5.2 error response. */
const oauthError = (status: number, error: string, description: string) => json(status, { error, error_description: description });

export function metadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: [...SCOPES],
    service_documentation: `${base}/`,
  };
}

function clientFrom(headers: Record<string, string | undefined>, form: URLSearchParams): { id?: string; secret?: string; via?: string } {
  const auth = headers["authorization"];
  if (auth?.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    if (i > 0) {
      return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)), via: "basic" };
    }
  }
  if (form.get("client_secret")) return { id: form.get("client_id") ?? undefined, secret: form.get("client_secret") ?? undefined, via: "post" };
  return {};
}

function clientOk(c: { id?: string; secret?: string }): boolean {
  return Boolean(c.id && c.secret && safeEqual(c.id, CLIENT_ID) && safeEqual(c.secret, CLIENT_SECRET));
}

function redirectAllowed(uri: string): boolean {
  return EXTRA_REDIRECTS.includes(uri) || AMAZON_REDIRECT.test(uri);
}

/** The resource (audience) a token is for: always this server's /mcp endpoint. */
function checkResource(requested: string | null, mcpResource: string): boolean {
  if (!requested) return true; // optional per RFC 8707; we still bind tokens to our /mcp
  return requested.replace(/\/+$/, "") === mcpResource || requested.replace(/\/+$/, "") === mcpResource.replace(/\/mcp$/, "");
}

function issueAccess(scopes: string[], mcpResource: string, sub?: string) {
  const access = sign({ typ: "access", iss: mcpResource.replace(/\/mcp$/, ""), aud: mcpResource, sub, scope: scopes.join(" "), iat: nowS(), exp: nowS() + ACCESS_TTL_S, jti: randomUUID() });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, scope: scopes.join(" ") };
}

export function handleOAuth(req: {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: string;
  base: string; // e.g. https://abc.lambda-url.us-east-1.on.aws
}): HttpResult | null {
  const { method, path, base } = req;
  const mcpResource = `${base}/mcp`;

  if (method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) {
    return json(200, metadata(base), { "cache-control": "public, max-age=300" });
  }
  if (method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return json(200, { resource: mcpResource, authorization_servers: [base], scopes_supported: [...SCOPES], bearer_methods_supported: ["header"] });
  }
  if (!path.startsWith("/oauth/")) return null;
  if (!oauthEnabled()) return oauthError(503, "temporarily_unavailable", "OAuth is not configured on this server.");

  // --- Authorization endpoint: show the linking page / handle the household key ----
  if (path === "/oauth/authorize") {
    const p = method === "POST" ? new URLSearchParams(req.body) : req.query;
    const clientId = p.get("client_id") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    const state = p.get("state") ?? "";
    const challenge = p.get("code_challenge") ?? "";
    const challengeMethod = p.get("code_challenge_method") ?? "";
    const scope = (p.get("scope") ?? "mcp:tools").split(/[ +]/).filter(Boolean);
    const resource = p.get("resource");

    // Errors before we trust redirect_uri are shown on the page, never redirected (RFC 6749 §4.1.2.1).
    if (!safeEqual(clientId, CLIENT_ID)) return page(400, errorPage("Unknown app (client_id)."));
    if (!redirectAllowed(redirectUri)) return page(400, errorPage("This redirect address isn't allowed."));
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (state) u.searchParams.set("state", state);
      return { status: 302, headers: { location: u.toString(), "cache-control": "no-store" }, body: "" };
    };
    if (p.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
    if (!challenge || challengeMethod !== "S256") return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    if (!checkResource(resource, mcpResource)) return back({ error: "invalid_target" });
    const granted = scope.filter((s) => s === "mcp:tools" || s === "mcp:resources");
    if (!granted.length) granted.push("mcp:tools");

    if (method === "GET") {
      return page(200, linkPage({ clientId, redirectUri, state, challenge, challengeMethod, scope: granted.join(" "), resource: resource ?? "" }));
    }
    if (p.get("decision") === "deny") return back({ error: "access_denied" });
    const key = p.get("household_key") ?? "";
    if (!HOUSEHOLD_KEY || !safeEqual(key.trim(), HOUSEHOLD_KEY)) {
      return page(401, linkPage({ clientId, redirectUri, state, challenge, challengeMethod, scope: granted.join(" "), resource: resource ?? "" }, "That household key didn't match. Try again."));
    }
    const code = sign({ typ: "code", cid: clientId, ruri: redirectUri, chal: challenge, sub: HOUSEHOLD_ID, scope: granted.join(" "), exp: nowS() + CODE_TTL_S, jti: randomUUID() });
    return back({ code });
  }

  // --- Token endpoint -------------------------------------------------------------
  if (path === "/oauth/token") {
    if (method !== "POST") return oauthError(405, "invalid_request", "Use POST.");
    if (req.query.toString()) return oauthError(400, "invalid_request", "Credentials must not be sent in the query string.");
    const form = new URLSearchParams(req.body);
    const client = clientFrom(req.headers, form);
    if (!clientOk(client)) return oauthError(401, "invalid_client", "Client authentication failed.");
    const grant = form.get("grant_type");

    if (grant === "client_credentials") {
      if (!checkResource(form.get("resource"), mcpResource)) return oauthError(400, "invalid_target", "Unknown resource.");
      const requested = (form.get("scope") ?? "mcp:service").split(" ").filter(Boolean);
      if (requested.some((s) => s !== "mcp:service")) return oauthError(400, "invalid_scope", "client_credentials may only request mcp:service.");
      return json(200, issueAccess(["mcp:service"], mcpResource)); // no refresh_token for client credentials
    }

    if (grant === "authorization_code") {
      const c = verify(form.get("code") ?? "");
      if (!c || c.typ !== "code") return oauthError(400, "invalid_grant", "The authorization code is invalid or expired.");
      if (c.cid !== client.id || c.ruri !== form.get("redirect_uri")) return oauthError(400, "invalid_grant", "client_id or redirect_uri mismatch.");
      const verifier = form.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return oauthError(400, "invalid_grant", "A valid code_verifier is required.");
      const computed = createHash("sha256").update(verifier).digest("base64url");
      if (!safeEqual(computed, String(c.chal))) return oauthError(400, "invalid_grant", "PKCE verification failed.");
      if (!checkResource(form.get("resource"), mcpResource)) return oauthError(400, "invalid_target", "Unknown resource.");
      const scopes = String(c.scope).split(" ");
      const refresh = sign({ typ: "refresh", cid: client.id, sub: c.sub, scope: c.scope, exp: nowS() + REFRESH_TTL_S, jti: randomUUID() });
      return json(200, { ...issueAccess(scopes, mcpResource, String(c.sub)), refresh_token: refresh });
    }

    if (grant === "refresh_token") {
      const r = verify(form.get("refresh_token") ?? "");
      if (!r || r.typ !== "refresh" || r.cid !== client.id) return oauthError(400, "invalid_grant", "The refresh token is invalid or expired.");
      const scopes = String(r.scope).split(" ");
      const refresh = sign({ typ: "refresh", cid: client.id, sub: r.sub, scope: r.scope, exp: nowS() + REFRESH_TTL_S, jti: randomUUID() });
      return json(200, { ...issueAccess(scopes, mcpResource, String(r.sub)), refresh_token: refresh });
    }

    return oauthError(400, "unsupported_grant_type", "Supported: client_credentials, authorization_code, refresh_token.");
  }

  return oauthError(404, "invalid_request", "Unknown OAuth endpoint.");
}

// ---------------------------------------------------------------------------
// Account-linking page
// ---------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(status: number, html: string): HttpResult {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'",
    },
    body: html,
  };
}

const SHELL = (inner: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link PetCheck</title><style>
body{margin:0;background:#f6f4ef;color:#1f2328;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;margin:8vh auto;padding:0 16px}.card{background:#fff;border:1px solid #e6e2d9;border-radius:16px;padding:24px}
h1{font-size:22px;margin:0 0 6px}p{color:#5b6068;margin:8px 0 16px}ul{color:#5b6068;padding-left:18px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d9d4c8;border-radius:10px;font:inherit;margin-bottom:12px}
.row{display:flex;gap:8px}button{flex:1;padding:12px;border-radius:10px;border:1px solid #d9d4c8;background:#fff;font:inherit;cursor:pointer}
button.primary{background:#3d5afe;border-color:#3d5afe;color:#fff}.err{color:#c4312b;font-size:14px}small{color:#8a8f98}
@media (prefers-color-scheme:dark){body{background:#15171a;color:#eceef0}.card{background:#1e2125;border-color:#2d3137}input,button{background:#25282c;color:#eceef0;border-color:#2d3137}p,ul{color:#9aa0a8}}
</style></head><body><main><div class="card">${inner}</div></main></body></html>`;

function errorPage(msg: string): string {
  return SHELL(`<h1>🐾 PetCheck</h1><p class="err">${esc(msg)}</p><small>Please go back to the Alexa app and try linking again.</small>`);
}

function linkPage(
  f: { clientId: string; redirectUri: string; state: string; challenge: string; challengeMethod: string; scope: string; resource: string },
  error?: string,
): string {
  const hidden = (name: string, v: string) => `<input type="hidden" name="${name}" value="${esc(v)}">`;
  return SHELL(`<h1>🐾 Link PetCheck to Alexa</h1>
<p>Alexa is asking to use your PetCheck household. Once linked, anyone at home can say things like “I fed Mochi”.</p>
<ul><li>Log feedings, walks and medication</li><li>Check what's done or still due today</li><li>Hear weekly summaries</li></ul>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("response_type", "code")}${hidden("client_id", f.clientId)}${hidden("redirect_uri", f.redirectUri)}${hidden("state", f.state)}
${hidden("code_challenge", f.challenge)}${hidden("code_challenge_method", f.challengeMethod)}${hidden("scope", f.scope)}${hidden("resource", f.resource)}
<label for="k"><small>Household key</small></label>
<input id="k" name="household_key" type="password" autocomplete="off" required autofocus placeholder="Paste your household key">
<div class="row"><button type="submit" name="decision" value="deny" formnovalidate>Cancel</button><button class="primary" type="submit" name="decision" value="allow">Link</button></div>
</form>
<p><small>PetCheck records and reminds. It never gives veterinary advice.</small></p>`);
}
