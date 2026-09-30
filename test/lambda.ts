// Calls the Lambda handler with fake Function URL events (no AWS needed).
//   API_KEY=test npm run test:lambda
import assert from "node:assert/strict";

process.env.API_KEY ??= "test";
const KEY = process.env.API_KEY;
const { handler } = await import("../src/lambda.js");

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

let r = await handler(event("GET", "/health"));
assert.equal(r.statusCode, 200);
console.log("✔ health:", r.body);

r = await handler(event("POST", "/mcp", rpc(1, "tools/list")));
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

r = await handler(event("POST", "/mcp", rpc(2, "tools/list"), auth));
assert.equal(r.statusCode, 200, r.body);
const names = JSON.parse(r.body!).result.tools.map((t: { name: string }) => t.name);
assert.equal(names.length, 6);
console.log("✔ tools/list:", names.join(", "));

r = await handler(event("POST", "/mcp", rpc(3, "tools/call", { name: "log_care", arguments: { pet: "Mochi", activity: "feed", by: "Dad" } }), auth));
assert.equal(r.statusCode, 200, r.body);
console.log("✔ log_care:", JSON.parse(r.body!).result.content[0].text);

r = await handler(event("POST", "/mcp", rpc(4, "tools/call", { name: "log_care", arguments: { pet: "Mochi", activity: "feed", by: "Emma" } }), auth));
console.log("✔ duplicate:", JSON.parse(r.body!).result.content[0].text);

r = await handler(event("GET", "/mcp", undefined, auth));
assert.equal(r.statusCode, 405);
console.log("✔ GET /mcp → 405");

console.log("\nAll Lambda handler checks passed.");
