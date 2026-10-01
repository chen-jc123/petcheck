// OAuth 2.1 flows exactly as Alexa+ would run them (no AWS, no server process).
//   npm run test:oauth
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

process.env.API_KEY = "household-key-123";
process.env.OAUTH_CLIENT_ID = "alexa-petcheck";
process.env.OAUTH_CLIENT_SECRET = "s3cret-client";
process.env.OAUTH_SIGNING_KEY = "signing-key-xyz";
const { handleOAuth, authenticate, mcpAccessError, sign } = await import("../src/oauth.js");

const base = "https://petcheck.example.on.aws";
const mcp = `${base}/mcp`;
const basic = "Basic " + Buffer.from("alexa-petcheck:s3cret-client").toString("base64");
const redirect = "https://layla.amazon.com/api/skill/link/M2ABCDEF";

const call = (method: string, path: string, opts: { query?: Record<string, string>; body?: Record<string, string>; headers?: Record<string, string> } = {}) =>
  handleOAuth({
    method,
    path,
    query: new URLSearchParams(opts.query ?? {}),
    headers: opts.headers ?? {},
    body: new URLSearchParams(opts.body ?? {}).toString(),
    base,
  })!;
const body = (r: { body: string }) => JSON.parse(r.body);

// 1. Discovery
let r = call("GET", "/.well-known/oauth-authorization-server");
const meta = body(r);
assert.equal(meta.issuer, base);
assert.deepEqual(meta.grant_types_supported, ["client_credentials", "authorization_code", "refresh_token"]);
assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
assert.ok(meta.scopes_supported.includes("mcp:service") && meta.scopes_supported.includes("mcp:tools"));
console.log("✔ metadata: issuer, endpoints, grants incl. client_credentials, PKCE S256, scopes");

// 2. Tier 1: client credentials → mcp:service, no refresh token
r = call("POST", "/oauth/token", { headers: { authorization: basic }, body: { grant_type: "client_credentials", resource: mcp } });
assert.equal(r.status, 200, r.body);
const svc = body(r);
assert.equal(svc.token_type, "Bearer");
assert.equal(svc.scope, "mcp:service");
assert.ok(svc.expires_in <= 3600 && !svc.refresh_token);
console.log("✔ client_credentials → Bearer mcp:service, expires_in", svc.expires_in, "s, no refresh_token");

let auth = authenticate(`Bearer ${svc.access_token}`, undefined, mcp);
assert.equal(auth?.kind, "service");
assert.equal(mcpAccessError(auth, { jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
assert.equal(mcpAccessError(auth, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_status" } })?.status, 403);
console.log("✔ service token: tools/list allowed, tools/call → 403 insufficient_scope (no household data)");

// Client-credentials negatives
assert.equal(call("POST", "/oauth/token", { headers: { authorization: "Basic " + Buffer.from("alexa-petcheck:wrong").toString("base64") }, body: { grant_type: "client_credentials" } }).status, 401);
assert.equal(body(call("POST", "/oauth/token", { headers: { authorization: basic }, body: { grant_type: "client_credentials", scope: "mcp:tools" } })).error, "invalid_scope");
assert.equal(body(call("POST", "/oauth/token", { headers: { authorization: basic }, body: { grant_type: "client_credentials", resource: "https://evil.example/mcp" } })).error, "invalid_target");
assert.equal(call("POST", "/oauth/token", { query: { client_secret: "s3cret-client" }, headers: { authorization: basic }, body: { grant_type: "client_credentials" } }).status, 400);
console.log("✔ rejected: wrong secret (401), user scope via client_credentials, foreign resource, secrets in query string");

// 3. Tier 2: authorization code + PKCE
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authQuery = {
  response_type: "code", client_id: "alexa-petcheck", redirect_uri: redirect, state: "xyz123",
  code_challenge: challenge, code_challenge_method: "S256", scope: "mcp:tools", resource: mcp,
};
r = call("GET", "/oauth/authorize", { query: authQuery });
assert.equal(r.status, 200);
assert.match(r.body, /Link PetCheck to Alexa/);
console.log("✔ GET /oauth/authorize → account-linking page");

assert.equal(call("GET", "/oauth/authorize", { query: { ...authQuery, redirect_uri: "https://evil.example/cb" } }).status, 400);
let deny = call("GET", "/oauth/authorize", { query: { ...authQuery, code_challenge_method: "plain" } });
assert.match(deny.headers.location, /error=invalid_request/);
console.log("✔ rejected: non-Amazon redirect_uri (shown on page, not redirected), PKCE 'plain'");

r = call("POST", "/oauth/authorize", { body: { ...authQuery, household_key: "wrong", decision: "allow" } });
assert.equal(r.status, 401);
assert.match(r.body, /didn(&#39;|')t match/);
r = call("POST", "/oauth/authorize", { body: { ...authQuery, decision: "deny" } });
assert.match(r.headers.location, /error=access_denied/);
assert.match(r.headers.location, /state=xyz123/);
console.log("✔ wrong household key → stays on page; Cancel → error=access_denied with state");

r = call("POST", "/oauth/authorize", { body: { ...authQuery, household_key: "household-key-123", decision: "allow" } });
assert.equal(r.status, 302);
const loc = new URL(r.headers.location);
assert.equal(loc.origin + loc.pathname, redirect);
assert.equal(loc.searchParams.get("state"), "xyz123");
const code = loc.searchParams.get("code")!;
console.log("✔ correct household key → 302 back to Alexa with code + state");

assert.equal(body(call("POST", "/oauth/token", { headers: { authorization: basic }, body: { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: randomBytes(32).toString("base64url") } })).error, "invalid_grant");
assert.equal(body(call("POST", "/oauth/token", { headers: { authorization: basic }, body: { grant_type: "authorization_code", code, redirect_uri: "https://layla.amazon.com/other", code_verifier: verifier } })).error, "invalid_grant");
console.log("✔ rejected: wrong code_verifier, mismatched redirect_uri");

r = call("POST", "/oauth/token", { headers: { authorization: basic }, body: { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, resource: mcp } });
assert.equal(r.status, 200, r.body);
const user = body(r);
assert.equal(user.scope, "mcp:tools");
assert.ok(user.refresh_token && user.expires_in <= 3600);
auth = authenticate(`Bearer ${user.access_token}`, undefined, mcp);
assert.equal(auth?.kind, "user");
assert.equal(auth?.household, "demo");
assert.equal(mcpAccessError(auth, { jsonrpc: "2.0", id: 3, method: "tools/call" }), null);
console.log("✔ code + verifier → mcp:tools access token (household demo) + refresh token; tools/call allowed");

// 4. Refresh
r = call("POST", "/oauth/token", { body: { grant_type: "refresh_token", refresh_token: user.refresh_token, client_id: "alexa-petcheck", client_secret: "s3cret-client" } });
assert.equal(r.status, 200, r.body);
assert.equal(body(r).scope, "mcp:tools");
console.log("✔ refresh_token (client_secret_post) → new access token");

// 5. Token hygiene
assert.equal(authenticate(`Bearer ${user.access_token}`, undefined, "https://other.example/mcp"), null);
const tampered = user.access_token.slice(0, -2) + (user.access_token.endsWith("A") ? "B" : "A") + user.access_token.slice(-1);
assert.equal(authenticate(`Bearer ${tampered}`, undefined, mcp), null);
const expired = sign({ typ: "access", aud: mcp, sub: "demo", scope: "mcp:tools", exp: Math.floor(Date.now() / 1000) - 5 });
assert.equal(authenticate(`Bearer ${expired}`, undefined, mcp), null);
assert.equal(authenticate(`Bearer ${code}`, undefined, mcp), null);
assert.equal(mcpAccessError(null, { method: "tools/list" })?.status, 401);
console.log("✔ rejected: token for another resource, tampered signature, expired token, auth code used as a token; no creds → 401");

// 6. Household key still works everywhere (household page, simulated Alexa+, Inspector)
assert.equal(authenticate(undefined, "household-key-123", mcp)?.kind, "api-key");
assert.equal(authenticate("Bearer household-key-123", undefined, mcp)?.kind, "api-key");
console.log("✔ household API key still accepted (x-api-key or Bearer)");

console.log("\nAll OAuth checks passed.");
