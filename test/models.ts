// The OpenAI- and Anthropic-compatible model adapters, end to end but offline:
//   runAssistant → adapter → fake model server (scripted tool call) → real MCP client → real PetCheck server
// Checks the wire format each protocol expects, and when the "auto" engine falls back to rules.
//   npm run test:models
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

process.env.API_KEY ??= "test";
const { app } = await import("../src/app.js");
const { runAssistant } = await import("../src/assistant.js");
const { modelConfig } = await import("../src/models.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const mcpUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;

// A fake model server: answers with a tool call first, then with text built from the tool result.
type Seen = { path: string; headers: IncomingMessage["headers"]; body: Record<string, any> };
const seen: Seen[] = [];
let script: (req: Seen) => { status?: number; body: unknown };
const fake = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const r: Seen = { path: req.url ?? "", headers: req.headers, body: JSON.parse(raw) };
  seen.push(r);
  const out = script(r);
  res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body));
});
fake.listen(0);
await new Promise((r) => fake.once("listening", r));
const fakeUrl = `http://localhost:${(fake.address() as AddressInfo).port}`;

const openaiScript = (tool: string, args: object) => (r: Seen) => {
  const last = r.body.messages[r.body.messages.length - 1];
  if (last.role !== "tool") {
    return { body: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } }] } };
  }
  return { body: { choices: [{ finish_reason: "stop", message: { content: `**Done.** ${last.content} 🐱` } }] } };
};
const anthropicScript = (tool: string, input: object) => (r: Seen) => {
  const last = r.body.messages[r.body.messages.length - 1];
  const result = last.content.find((c: { type: string }) => c.type === "tool_result");
  if (!result) {
    return { body: { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "" }, { type: "tool_use", id: "toolu_1", name: tool, input }] } };
  }
  return { body: { stop_reason: "end_turn", content: [{ type: "text", text: `Done. ${result.content}` }] } };
};

try {
  // 1. OpenAI-compatible Chat Completions.
  Object.assign(process.env, {
    ASSISTANT_ENGINE: "openai",
    OPENAI_BASE_URL: `${fakeUrl}/compatible-mode/v1/`,
    OPENAI_API_KEY: "sk-openai",
    OPENAI_MODEL: "fake-gpt",
    OPENAI_EXTRA_BODY: '{"enable_thinking":false}',
  });
  script = openaiScript("log_care", { pet: "Mochi", activity: "feed", by: "Dad" });
  seen.length = 0;
  let r = await runAssistant({ text: "I fed Mochi", speaker: "Dad" }, { mcpUrl, apiKey: "test" });
  assert.equal(seen.length, 2);
  const [o1, o2] = seen;
  assert.equal(o1.path, "/compatible-mode/v1/chat/completions");
  assert.equal(o1.headers.authorization, "Bearer sk-openai");
  assert.equal(o1.body.model, "fake-gpt");
  assert.equal(o1.body.enable_thinking, false, "OPENAI_EXTRA_BODY is merged in");
  assert.equal(o1.body.messages[0].role, "system");
  assert.match(o1.body.messages[0].content, /The person speaking right now is Dad/);
  assert.equal(o1.body.tools.length, 6, "all 6 MCP tools are offered");
  assert.ok(o1.body.tools.every((t: any) => t.type === "function" && t.function.parameters.type === "object" && !("$schema" in t.function.parameters)));
  const call = o2.body.messages.find((m: any) => m.role === "assistant");
  const result = o2.body.messages.find((m: any) => m.role === "tool");
  assert.equal(call.tool_calls[0].id, "call_1");
  assert.equal(result.tool_call_id, "call_1");
  assert.match(result.content, /^Got it\. Dad fed Mochi/);
  assert.equal(r.engine, "openai");
  assert.equal(r.engineLabel, "OpenAI-compatible API");
  assert.equal(r.model, "fake-gpt");
  assert.match(r.reply, /^Done\. Got it\. Dad fed Mochi at .*\.$/, "markdown and emoji are not spoken");
  assert.ok(r.trace.some((t) => t.method === "tools/call" && t.tool === "log_care" && t.status === 200), "the tool ran on the MCP server");
  console.log("✔ OpenAI-compatible: tool call → MCP log_care → reply:", r.reply);

  // A failed tool is marked as an error for the model.
  script = openaiScript("log_care", { pet: "Rex", activity: "feed", by: "Dad" });
  seen.length = 0;
  r = await runAssistant({ text: "I fed Rex", speaker: "Dad" }, { mcpUrl, apiKey: "test" });
  assert.match(seen[1].body.messages.find((m: any) => m.role === "tool").content, /^Error: I don't know a pet called Rex/);
  assert.ok(r.toolCalls[0].isError);
  console.log("✔ OpenAI-compatible: failed tool reaches the model as “Error: …”");

  // 2. Anthropic-compatible Messages.
  Object.assign(process.env, {
    ASSISTANT_ENGINE: "anthropic",
    ANTHROPIC_BASE_URL: `${fakeUrl}/apps/anthropic`,
    ANTHROPIC_API_KEY: "sk-anthropic",
    ANTHROPIC_MODEL: "fake-claude",
  });
  script = anthropicScript("get_status", { pet: "Biscuit" });
  seen.length = 0;
  r = await runAssistant(
    { text: "How about Biscuit?", speaker: "Mom", history: [{ role: "user", text: "How's Mochi today?" }, { role: "assistant", text: "Mochi has had breakfast." }] },
    { mcpUrl, apiKey: "test" },
  );
  const [a1, a2] = seen;
  assert.equal(a1.path, "/apps/anthropic/v1/messages");
  assert.equal(a1.headers["x-api-key"], "sk-anthropic");
  assert.equal(a1.headers["anthropic-version"], "2023-06-01");
  assert.equal(a1.body.model, "fake-claude");
  assert.match(a1.body.system, /The person speaking right now is Mom/);
  assert.deepEqual(a1.body.thinking, { type: "disabled" });
  assert.equal(a1.body.tools.length, 6);
  assert.ok(a1.body.tools.every((t: any) => t.input_schema.type === "object"));
  assert.deepEqual(a1.body.messages.map((m: any) => m.role), ["user", "assistant", "user"], "earlier turns are sent as context");
  const use = a2.body.messages[3].content.find((c: any) => c.type === "tool_use");
  const res = a2.body.messages[4].content.find((c: any) => c.type === "tool_result");
  assert.ok(!a2.body.messages[3].content.some((c: any) => c.type === "thinking"), "thinking blocks are not sent back");
  assert.equal(use.id, "toolu_1");
  assert.equal(res.tool_use_id, "toolu_1");
  assert.equal(res.is_error, undefined);
  assert.equal(r.engine, "anthropic");
  assert.match(r.reply, /^Done\. .*Biscuit/);
  console.log("✔ Anthropic-compatible: tool_use → MCP get_status → tool_result → reply:", r.reply.slice(0, 80) + "…");

  script = anthropicScript("log_care", { pet: "Rex", activity: "walk" });
  seen.length = 0;
  await runAssistant({ text: "I walked Rex", speaker: "Mom" }, { mcpUrl, apiKey: "test" });
  assert.equal(seen[1].body.messages[2].content[0].is_error, true);
  console.log("✔ Anthropic-compatible: failed tool is sent with is_error: true");

  // 3. Errors: a bad request is never hidden; an unavailable model falls back to rules only in "auto".
  script = () => ({ status: 400, body: { error: { message: "tools[0] is invalid" } } });
  await assert.rejects(runAssistant({ text: "I fed Mochi", speaker: "Dad" }, { mcpUrl, apiKey: "test" }), /ModelRequestError|HTTP 400: tools\[0\] is invalid/);
  script = () => ({ status: 401, body: { error: { message: "Invalid API key" } } });
  await assert.rejects(runAssistant({ text: "I fed Mochi", speaker: "Dad" }, { mcpUrl, apiKey: "test" }), /HTTP 401: Invalid API key/);
  console.log("✔ ASSISTANT_ENGINE=anthropic: HTTP 400 and 401 are reported, no silent fallback");

  assert.throws(() => modelConfig("openai", { OPENAI_API_KEY: "k" }), /needs OPENAI_API_KEY and OPENAI_MODEL/);
  assert.throws(() => modelConfig("gpt"), /should be auto, openai, anthropic, bedrock or rules/);
  assert.equal(modelConfig("auto", { ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "m" })?.engine, "anthropic");
  assert.equal(modelConfig("auto", {})?.engine, "bedrock");
  console.log("✔ settings: incomplete or unknown engines are refused; auto picks openai → anthropic → bedrock");

  process.env.ASSISTANT_ENGINE = "auto"; // OPENAI_API_KEY is set, so auto means openai
  r = await runAssistant({ text: "Has anyone walked Biscuit?", speaker: "Dad" }, { mcpUrl, apiKey: "test" });
  assert.equal(r.engine, "rules");
  assert.match(r.engineNote ?? "", /^OpenAI-compatible API unavailable: ModelUnavailableError: OpenAI-compatible API HTTP 401/);
  assert.ok(r.trace.some((t) => t.method === "tools/call" && t.tool === "get_status"), "the rules engine still goes through MCP");
  console.log("✔ ASSISTANT_ENGINE=auto: HTTP 401 → rules engine:", r.reply.slice(0, 60) + "…");

  console.log("\nAll model adapter checks passed.");
} finally {
  server.close();
  fake.close();
}
