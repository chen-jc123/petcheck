// End-to-end test of the simulated Alexa+ path WITHOUT Bedrock:
//   runAssistant → real MCP client → HTTP → real PetCheck server (memory storage)
// Bedrock is replaced by a scripted fake that asks for the tools a real model would.
//   npm run test:assistant
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

process.env.API_KEY ??= "test";
const { app } = await import("../src/app.js");
const { runAssistant } = await import("../src/assistant.js");
type ConverseFn = import("../src/assistant.js").ConverseFn;

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const mcpUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;

/** A fake model: first asks for one tool call, then answers from the tool result. */
function scripted(tool: string, input: Record<string, unknown>, finalText: (toolResult: string) => string): ConverseFn {
  return async (req) => {
    assert.equal(req.toolConfig.tools.length, 6, "the model is offered all 6 PetCheck tools (from MCP tools/list)");
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

  // 5. Bedrock refuses this account → automatic switch to the rules engine, still via MCP.
  const blocked: ConverseFn = async () => {
    const e = new Error(
      "To access Amazon Bedrock, you must provide further information so we can verify you are a corporate customer",
    );
    e.name = "ValidationException";
    throw e;
  };
  r = await runAssistant({ text: "Has anyone walked Biscuit?", speaker: "Mom" }, { mcpUrl, apiKey: "test", bedrock: blocked });
  assert.equal(r.engine, "rules");
  assert.match(r.engineNote ?? "", /Bedrock unavailable: ValidationException/);
  assert.ok(r.trace.some((t) => t.method === "tools/call" && t.tool === "get_status"), "rules engine still calls the MCP server");
  console.log("✔ Bedrock blocked → rules engine:", r.reply);

  // 6. Rules engine handles the duplicate follow-up “yes”.
  const dup = await runAssistant({ text: "I fed Mochi", speaker: "Emma" }, { mcpUrl, apiKey: "test", bedrock: blocked });
  assert.match(dup.reply, /already fed Mochi/);
  r = await runAssistant(
    { text: "yes", speaker: "Emma", history: [{ role: "user", text: "I fed Mochi" }, { role: "assistant", text: dup.reply }] },
    { mcpUrl, apiKey: "test", bedrock: blocked },
  );
  assert.match(r.reply, /^Got it\. Emma fed Mochi/);
  console.log("✔ Emma: “I fed Mochi” →", dup.reply, "→ “yes” →", r.reply);

  // 7. Vet-advice question never reaches a tool.
  r = await runAssistant({ text: "Can dogs eat grapes?", speaker: "Dad" }, { mcpUrl, apiKey: "test", bedrock: blocked });
  assert.equal(r.toolCalls.length, 0);
  console.log("✔ “Can dogs eat grapes?” →", r.reply);

  console.log("\nAll assistant checks passed.");
} finally {
  server.close();
}
