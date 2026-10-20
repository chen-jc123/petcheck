// End-to-end test of the simulated Alexa+ path WITHOUT a real model:
//   runAssistant → real MCP client → HTTP → real PetCheck server (memory storage)
// The model is replaced by a scripted fake that asks for the tools a real model would.
// Also: conversations kept server-side (sessions) and the device location for the care network.
//   npm run test:assistant
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.API_KEY ??= "test";
const { app } = await import("../src/app.js");
const { runAssistant } = await import("../src/assistant.js");
type ConverseFn = import("../src/assistant.js").ConverseFn;
type Message = import("../src/assistant.js").Message;

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const mcpUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;

/** A fake model: first asks for one tool call, then answers from the tool result. */
function scripted(tool: string, input: Record<string, unknown>, finalText: (toolResult: string) => string): ConverseFn {
  return async (req) => {
    assert.equal(req.toolConfig.tools.length, 10, "the model is offered all 10 PetCheck tools (from MCP tools/list)");
    assert.ok(req.toolConfig.tools.every((t) => !("$schema" in (t.toolSpec.inputSchema.json as object))), "no $schema in tool schemas");
    assert.match(req.system[0].text, /The person speaking right now is/);
    const last = req.messages[req.messages.length - 1];
    const toolResult = last.content.find((c) => "toolResult" in c) as { toolResult: { content: { text: string }[] } } | undefined;
    if (!toolResult) {
      return {
        stopReason: "tool_use",
        output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: tool, input } }] } },
      };
    }
    const text = toolResult.toolResult.content[0].text;
    return {
      stopReason: "end_turn",
      output: { message: { role: "assistant", content: [{ text: `<thinking>planning</thinking> ${finalText(text)}` }] } },
    };
  };
}

try {
  // 1. Dad logs a feeding.
  let r = await runAssistant(
    { text: "I fed Mochi", speaker: "Dad" },
    { mcpUrl, apiKey: "test", converse: scripted("log_care", { pet: "Mochi", activity: "feed", by: "Dad" }, (t) => t) },
  );
  assert.match(r.reply, /^Got it\. Dad fed Mochi/);
  assert.ok(!r.reply.includes("thinking"), "reasoning tags are stripped");
  const methods = r.trace.map((t) => t.method);
  assert.ok(methods.includes("initialize") && methods.includes("tools/list") && methods.includes("tools/call"), methods.join(","));
  const call = r.trace.find((t) => t.method === "tools/call")!;
  assert.equal(call.status, 200);
  assert.equal(call.tool, "log_care");
  console.log("✔ Dad: “I fed Mochi” →", r.reply);
  console.log("   MCP over HTTP:", r.trace.map((t) => `${t.method}${t.tool ? ` ${t.tool}` : ""} [${t.status}, ${t.ms}ms]`).join(" → "));

  // 2. Emma says the same thing: the server's duplicate check comes back through MCP.
  r = await runAssistant(
    { text: "I just fed Mochi", speaker: "Emma" },
    { mcpUrl, apiKey: "test", converse: scripted("log_care", { pet: "Mochi", activity: "feed", by: "Emma" }, (t) => t) },
  );
  assert.match(r.reply, /Dad already fed Mochi/);
  console.log("✔ Emma: “I just fed Mochi” →", r.reply);

  // 3. Read-only question.
  r = await runAssistant(
    { text: "How's Mochi doing this week?", speaker: "Mom", history: [{ role: "user", text: "hi" }, { role: "assistant", text: "Hi!" }] },
    { mcpUrl, apiKey: "test", converse: scripted("weekly_summary", { pet: "Mochi" }, (t) => t.split(". ").slice(0, 2).join(". ") + ".") },
  );
  assert.match(r.reply, /Mochi was fed/);
  console.log("✔ Mom: “How's Mochi doing this week?” →", r.reply);

  // 4. Wrong API key: the MCP server refuses the client.
  await assert.rejects(
    runAssistant({ text: "I fed Mochi" }, { mcpUrl, apiKey: "wrong", converse: scripted("get_status", {}, (t) => t) }),
  );
  console.log("✔ wrong key → MCP server rejects the assistant");

  // 5. The model service refuses this account (Bedrock's allowlisting error) → automatic switch to the rules engine, still via MCP.
  const blocked: ConverseFn = async () => {
    const e = new Error(
      "To access Amazon Bedrock, you must provide further information so we can verify you are a corporate customer",
    );
    e.name = "ValidationException";
    throw e;
  };
  r = await runAssistant({ text: "Has anyone walked Biscuit?", speaker: "Mom" }, { mcpUrl, apiKey: "test", model: blocked });
  assert.equal(r.engine, "rules");
  assert.match(r.engineNote ?? "", /Bedrock unavailable: ValidationException/);
  assert.ok(r.trace.some((t) => t.method === "tools/call" && t.tool === "get_status"), "rules engine still calls the MCP server");
  console.log("✔ Bedrock blocked → rules engine:", r.reply);

  // 6. Rules engine handles the duplicate follow-up “yes”.
  const dup = await runAssistant({ text: "I fed Mochi", speaker: "Emma" }, { mcpUrl, apiKey: "test", model: blocked });
  assert.match(dup.reply, /already fed Mochi/);
  r = await runAssistant(
    { text: "yes", speaker: "Emma", history: [{ role: "user", text: "I fed Mochi" }, { role: "assistant", text: dup.reply }] },
    { mcpUrl, apiKey: "test", model: blocked },
  );
  assert.match(r.reply, /^Got it\. Emma fed Mochi/);
  console.log("✔ Emma: “I fed Mochi” →", dup.reply, "→ “yes” →", r.reply);

  // 7. Vet-advice question never reaches a tool.
  r = await runAssistant({ text: "Can dogs eat grapes?", speaker: "Dad" }, { mcpUrl, apiKey: "test", model: blocked });
  assert.equal(r.toolCalls.length, 0);
  console.log("✔ “Can dogs eat grapes?” →", r.reply);

  // 8. Demo clock: the whole turn, including the MCP tool call on the server, runs at 5:40 PM.
  const { withDemoTime, localParts } = await import("../src/clock.js");
  r = await withDemoTime("17:40", () =>
    runAssistant({ text: "I fed Biscuit", speaker: "Mom", time: "17:40" } as never, { mcpUrl, apiKey: "test", model: blocked, demoTime: "17:40" }),
  );
  assert.match(r.reply, /Mom fed Biscuit/);
  const today = await (await fetch(mcpUrl.replace("/mcp", "/api/today?time=17:45"), { headers: { "x-api-key": "test" } })).json();
  const ev = today.events.find((e: { by: string; at: string }) => e.by === "Mom" && localParts(new Date(e.at)).minutes === 17 * 60 + 40);
  assert.ok(ev, "the log is stamped 5:40 PM, not the real time");
  const dinner = today.pets.find((p: { name: string }) => p.name === "Biscuit").slots.find((s: { label: string }) => s.label === "dinner");
  assert.equal(dinner.state, "done");
  console.log("✔ demo clock 5:40 PM → Biscuit's dinner logged at 5:40 PM:", r.reply);

  // 9. Multi-turn: with a session, turn 2 sees turn 1's tool call and its result, not only the words.
  const calls: Message[][] = [];
  const capture = (fn: ConverseFn): ConverseFn => async (req) => {
    calls.push(JSON.parse(JSON.stringify(req.messages)));
    return fn(req);
  };
  const sid = "test-session-0001";
  r = await runAssistant(
    { text: "How's Mochi today?", speaker: "Mom", sessionId: sid },
    { mcpUrl, apiKey: "test", converse: capture(scripted("get_status", { pet: "Mochi" }, (t) => t)) },
  );
  assert.equal(r.sessionId, sid);
  assert.equal(r.turnsInContext, 0);
  r = await runAssistant(
    { text: "How about Biscuit?", speaker: "Mom", sessionId: sid },
    { mcpUrl, apiKey: "test", converse: capture(scripted("get_status", { pet: "Biscuit" }, (t) => t)) },
  );
  assert.equal(r.turnsInContext, 1);
  const turn2 = calls[2]; // turn 1 made two model calls
  assert.deepEqual(turn2.map((m) => m.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.ok(turn2.some((m) => m.content.some((c) => "toolUse" in c && c.toolUse.name === "get_status")), "turn 1's tool call");
  assert.ok(turn2.some((m) => m.content.some((c) => "toolResult" in c && /Mochi/.test(c.toolResult.content[0].text))), "turn 1's tool result");
  console.log("✔ session: turn 2 is sent turn 1's get_status call and result →", r.reply.slice(0, 60) + "…");

  r = await runAssistant({ text: "Hi", speaker: "Dad", sessionId: "test-session-0002" }, { mcpUrl, apiKey: "test", model: blocked });
  assert.equal(r.turnsInContext, 0, "another device starts its own conversation");
  r = await runAssistant({ text: "Hi", speaker: "Dad", sessionId: "../../etc/passwd" }, { mcpUrl, apiKey: "test", model: blocked });
  assert.equal(r.sessionId, undefined, "an id that isn't a plain token is ignored");
  console.log("✔ sessions are per conversation; unsafe ids are ignored");

  // 10. A sitter's device location reaches the MCP server and the care network searches from there.
  r = await runAssistant(
    { text: "Any dog walking jobs near me?", speaker: "Sam", role: "sitter", location: { lat: 42.286, lng: -83.747, label: "Kerrytown" } },
    {
      mcpUrl,
      apiKey: "test",
      converse: async (req) => {
        assert.match(req.system[0].text, /Sam, a pet sitter/);
        return scripted("find_care_requests", { services: ["walk"], max_distance_miles: 2, sitter: "Sam" }, (t) => t)(req);
      },
    },
  );
  const find = r.trace.find((t) => t.tool === "find_care_requests")!;
  assert.equal((find.response as { result: { structuredContent: { searchedFrom: string } } }).result.structuredContent.searchedFrom, "Kerrytown");
  assert.match(r.reply, /^I found \d jobs?\. R-1031: dog walks for Luna, .*0\.5 miles away in Water Hill/);
  console.log("✔ sitter on a phone in Kerrytown →", r.reply.slice(0, 90) + "…");

  console.log("\nAll assistant checks passed.");
} finally {
  server.close();
}
