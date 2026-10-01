// Calls the Lambda handler with fake Function URL events (no AWS needed).
//   API_KEY=test npm run test:lambda
import assert from "node:assert/strict";

process.env.API_KEY ??= "test";
process.env.OAUTH_CLIENT_ID = "alexa-petcheck";
process.env.OAUTH_CLIENT_SECRET = "client-secret";
process.env.OAUTH_SIGNING_KEY = "signing-key";
const KEY = process.env.API_KEY;
const { handler } = await import("../src/lambda.js");
type HttpResult = { statusCode: number; headers?: Record<string, string>; body?: string };
const http = async (e: ReturnType<typeof event>) => (await handler(e)) as HttpResult;

const event = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => ({
  rawPath: path,
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...headers,
  },
  body: body === undefined ? undefined : Buffer.from(JSON.stringify(body)).toString("base64"),
  isBase64Encoded: true,
  requestContext: { domainName: "example.lambda-url.us-east-1.on.aws", http: { method } },
});
const auth = { authorization: `Bearer ${KEY}` };
const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

let r = await http(event("GET", "/health"));
assert.equal(r.statusCode, 200);
console.log("✔ health:", r.body);

r = await http(event("POST", "/mcp", rpc(1, "tools/list")));
assert.equal(r.statusCode, 401);
console.log("✔ no key → 401");

r = await handler(
  event("POST", "/mcp", rpc(1, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  }), auth),
);
assert.equal(r.statusCode, 200, r.body);
console.log("✔ initialize:", JSON.parse(r.body!).result.serverInfo);

r = await http(event("POST", "/mcp", rpc(2, "tools/list"), auth));
assert.equal(r.statusCode, 200, r.body);
const names = JSON.parse(r.body!).result.tools.map((t: { name: string }) => t.name);
assert.equal(names.length, 6);
console.log("✔ tools/list:", names.join(", "));

r = await http(event("POST", "/mcp", rpc(3, "tools/call", { name: "log_care", arguments: { pet: "Mochi", activity: "feed", by: "Dad" } }), auth));
assert.equal(r.statusCode, 200, r.body);
console.log("✔ log_care:", JSON.parse(r.body!).result.content[0].text);

r = await http(event("POST", "/mcp", rpc(4, "tools/call", { name: "log_care", arguments: { pet: "Mochi", activity: "feed", by: "Emma" } }), auth));
console.log("✔ duplicate:", JSON.parse(r.body!).result.content[0].text);

r = await http(event("GET", "/mcp", undefined, auth));
assert.equal(r.statusCode, 405);
console.log("✔ GET /mcp → 405");

r = await http(event("GET", "/api/today", undefined, auth));
assert.equal(r.statusCode, 200, r.body);
const view = JSON.parse(r.body!);
assert.ok(Array.isArray(view.pets) && view.pets.length === 2);
console.log("✔ GET /api/today:", view.pets.map((p: { name: string }) => p.name).join(", "), `(${view.events.length} logs today)`);

r = await http(event("POST", "/api/check-missed", { time: "18:30" }, auth));
assert.equal(r.statusCode, 200, r.body);
const check = JSON.parse(r.body!);
console.log(`✔ POST /api/check-missed at 18:30: ${check.alerts.length} new alert(s)`);
for (const a of check.alerts) console.log(`    [${a.level}] ${a.message}`);

r = await http(event("POST", "/api/check-missed", { time: "7pm" }, auth));
assert.equal(r.statusCode, 400);
console.log("✔ bad time → 400:", JSON.parse(r.body!).error);

r = await http(event("OPTIONS", "/api/today"));
assert.equal(r.statusCode, 204);
console.log("✔ CORS preflight → 204");

for (const p of ["/privacy", "/terms"]) {
  const lr = await http(event("GET", p));
  assert.equal(lr.statusCode, 200);
  assert.match(lr.body!, /PetCheck (Privacy Policy|Terms of Use)/);
}
console.log("✔ GET /privacy and /terms → listing pages");

r = await http(event("GET", "/"));
assert.equal(r.statusCode, 200);
assert.match(r.body!, /PetCheck/);
assert.match(r.headers!["content-type"], /text\/html/);
console.log(`✔ GET / → household page (${r.body!.length} bytes of HTML)`);

const scheduled = (await handler({ petcheck: "check-missed" })) as { checkedAt: string; alerts: unknown[] };
assert.ok(scheduled.checkedAt);
console.log(`✔ scheduled event: checked at ${scheduled.checkedAt}, ${scheduled.alerts.length} new alert(s)`);

// OAuth through the real handler: service token can list tools but not call them;
// a linked-household token (authorization code + PKCE) can call tools.
{
  const { createHash, randomBytes } = await import("node:crypto");
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => ({
    rawPath: path,
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
    isBase64Encoded: false,
    requestContext: { domainName: "example.lambda-url.us-east-1.on.aws", http: { method: "POST" } },
  });
  const mcpUrl = "https://example.lambda-url.us-east-1.on.aws/mcp";
  const basic = { authorization: "Basic " + Buffer.from("alexa-petcheck:client-secret").toString("base64") };

  r = await http(event("GET", "/.well-known/oauth-authorization-server"));
  assert.equal(JSON.parse(r.body!).issuer, "https://example.lambda-url.us-east-1.on.aws");
  r = await http(form("/oauth/token", { grant_type: "client_credentials", resource: mcpUrl }, basic));
  const svc = JSON.parse(r.body!).access_token;
  r = await http(event("POST", "/mcp", rpc(10, "tools/list"), { authorization: `Bearer ${svc}` }));
  assert.equal(r.statusCode, 200, r.body);
  r = await http(event("POST", "/mcp", rpc(11, "tools/call", { name: "get_status", arguments: {} }), { authorization: `Bearer ${svc}` }));
  assert.equal(r.statusCode, 403);
  console.log("✔ OAuth service token: tools/list 200, tools/call 403 insufficient_scope");

  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code", client_id: "alexa-petcheck", redirect_uri: "https://layla.amazon.com/api/skill/link/X", state: "s1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", scope: "mcp:tools",
  });
  r = await http({ ...event("GET", "/oauth/authorize"), rawQueryString: q.toString() } as never);
  assert.equal(r.statusCode, 200);
  assert.match(r.headers!["content-type"], /text\/html/);
  r = await http(form("/oauth/authorize", { ...Object.fromEntries(q), household_key: process.env.API_KEY!, decision: "allow" }));
  assert.equal(r.statusCode, 302);
  const code = new URL(r.headers!.location).searchParams.get("code")!;
  r = await http(form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: "https://layla.amazon.com/api/skill/link/X", code_verifier: verifier }, basic));
  const user = JSON.parse(r.body!).access_token;
  r = await http(event("POST", "/mcp", rpc(12, "tools/call", { name: "get_status", arguments: { pet: "Mochi" } }), { authorization: `Bearer ${user}` }));
  assert.equal(r.statusCode, 200, r.body);
  console.log("✔ OAuth account linking (code + PKCE) → tools/call get_status:", JSON.parse(r.body!).result.content[0].text.slice(0, 60) + "…");
}

console.log("\nAll Lambda handler checks passed.");
