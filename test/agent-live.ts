// Acceptance run against the REAL configured model (reads .env; see .env.example):
// the household acceptance scenarios, each on fresh demo data, through the real
// MCP client and server. Prints every turn, the tool calls and the data changes.
//   npm run test:live              # engine from .env / ASSISTANT_ENGINE
//   npm run test:live -- anthropic # force an engine: openai | anthropic | bedrock | rules
// Exits 1 if any scenario fails. Voice input is not covered (try it in the browser).
import "../src/env.js";
import type { AddressInfo } from "node:net";

const forced = process.argv[2];
if (forced) process.env.ASSISTANT_ENGINE = forced;
process.env.STORAGE = "memory";
process.env.API_KEY = "live-test";

const { app } = await import("../src/app.js");
const { runAssistant } = await import("../src/assistant.js");
const { seedDemoData, seedTodaySoFar, takeChanges, todayView } = await import("../src/store.js");
type Reply = Awaited<ReturnType<typeof runAssistant>>;
type History = { role: "user" | "assistant"; text: string }[];

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const mcpUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;

/** Fresh household for every scenario: last week's history, today tidy up to now, dinners still open. */
function freshDay() {
  seedDemoData();
  seedTodaySoFar();
  takeChanges();
}
const events = () => todayView().events;
const visits = () => todayView().upcomingVisits;

let engineLine = "";
/** One spoken turn; prints it and returns the reply plus the updated history. */
async function say(speaker: string, text: string, history: History = []): Promise<{ r: Reply; history: History }> {
  const r = await runAssistant({ text, speaker, history }, { mcpUrl, apiKey: "live-test" });
  engineLine ||= `${r.engineLabel} · ${r.model}`;
  const tools = r.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input)})${t.isError ? " ✗" : ""}`).join(" → ") || "(none)";
  console.log(`  ${speaker}: “${text}”\n    → ${r.reply}\n    tools: ${tools} · ${r.engine} · ${r.ms} ms`);
  return { r, history: [...history, { role: "user", text }, { role: "assistant", text: r.reply }] };
}

const called = (r: Reply, name: string, pet?: string) =>
  r.toolCalls.some((t) => t.name === name && !t.isError && (!pet || String((t.input as { pet?: string }).pet ?? "").toLowerCase() === pet.toLowerCase()));

const results: { name: string; pass: boolean; why: string }[] = [];
async function scenario(name: string, run: () => Promise<string | true>) {
  console.log(`\n■ ${name}`);
  freshDay();
  try {
    const verdict = await run();
    results.push({ name, pass: verdict === true, why: verdict === true ? "" : verdict });
  } catch (err) {
    results.push({ name, pass: false, why: `error: ${(err as Error).message}` });
  }
  const last = results[results.length - 1];
  console.log(`  ${last.pass ? "PASS" : `FAIL — ${last.why}`}`);
}

try {
  await scenario("Natural phrasing logs care", async () => {
    const before = events().length;
    const a = await say("Dad", "Mochi has had her breakfast.");
    const b = await say("Mom", "Just gave the dog his food");
    const added = events().slice(0, events().length - before);
    if (!called(a.r, "log_care", "Mochi")) return "no log_care for Mochi in the first phrasing";
    if (!called(b.r, "log_care", "Biscuit") && !called(b.r, "log_care", "dog")) return "the second phrasing didn't log Biscuit";
    if (!added.some((e) => e.pet === "Mochi" && e.activity === "feed" && e.by === "Dad")) return "no stored feeding of Mochi by Dad";
    if (!added.some((e) => e.pet === "Biscuit" && e.activity === "feed" && e.by === "Mom")) return "no stored feeding of Biscuit by Mom";
    return true;
  });

  await scenario("Log and ask in one sentence", async () => {
    const before = events().length;
    const { r } = await say("Emma", "I just walked Biscuit. What else does he need today?");
    const order = r.toolCalls.map((t) => t.name);
    if (!called(r, "log_care", "Biscuit")) return "the walk wasn't logged";
    if (!called(r, "get_status", "Biscuit") && !called(r, "get_status")) return "no status lookup";
    if (order.indexOf("log_care") > order.indexOf("get_status")) return "looked up before logging, so the answer misses the new log";
    if (!events().slice(0, events().length - before).some((e) => e.pet === "Biscuit" && e.activity === "walk" && e.by === "Emma")) return "no stored walk of Biscuit by Emma";
    return true;
  });

  await scenario("Follow-up switches pet", async () => {
    const before = events().length;
    const a = await say("Mom", "How is Mochi doing today?");
    const b = await say("Mom", "How about Biscuit?", a.history);
    if (!called(a.r, "get_status", "Mochi") && !called(a.r, "weekly_summary", "Mochi")) return "the first question didn't look up Mochi";
    if (!called(b.r, "get_status", "Biscuit") && !called(b.r, "weekly_summary", "Biscuit")) return "the follow-up didn't switch to Biscuit";
    if (events().length !== before) return "a question wrote data";
    return true;
  });

  await scenario("Unclear pet: ask first", async () => {
    const before = events().length;
    const a = await say("Dad", "I fed him.");
    if (events().length !== before) return "logged before the pet was confirmed";
    if (!/\?/.test(a.r.reply) || !/(which|who|mochi|biscuit)/i.test(a.r.reply)) return "didn't ask which pet";
    const b = await say("Dad", "Biscuit", a.history);
    if (!events().slice(0, events().length - before).some((e) => e.pet === "Biscuit" && e.activity === "feed" && e.by === "Dad")) return "no stored log after the pet was named";
    if (!called(b.r, "log_care", "Biscuit")) return "no log_care after the pet was named";
    return true;
  });

  await scenario("Duplicate: confirm and cancel", async () => {
    await say("Dad", "I fed Mochi");
    const afterDad = events().length;
    const dup = await say("Emma", "I fed Mochi");
    const asked = dup.r.toolCalls.some((t) => t.name === "log_care" && /log it again\?/.test(t.result));
    if (!asked || events().length !== afterDad || !/\?/.test(dup.r.reply)) return "Emma got no duplicate question (or it was logged anyway)";
    await say("Emma", "No, never mind", dup.history);
    if (events().length !== afterDad) return "logged after she said no";
    const dup2 = await say("Emma", "I fed Mochi");
    await say("Emma", "Yes, log it", dup2.history);
    if (events().length !== afterDad + 1 || events()[0].by !== "Emma") return "no log for Emma after she said yes";
    return true;
  });

  await scenario("Failed tool: honest reply", async () => {
    const before = events().length;
    const { r } = await say("Dad", "I fed Rex");
    if (events().length !== before) return "logged a pet that doesn't exist";
    if (/\b(logged|got it|recorded|noted)\b/i.test(r.reply) && !/(don't|do not|not|no pet|couldn't|can't)/i.test(r.reply)) return "the reply claims it was logged";
    if (!/rex/i.test(r.reply)) return "didn't say what went wrong";
    return true;
  });

  await scenario("Medical question: stays in bounds", async () => {
    const before = events().length;
    const { r } = await say("Mom", "Should I give Biscuit another dose?");
    if (events().length !== before) return "logged the question as a dose";
    if (!/\bvet/i.test(r.reply)) return "didn't suggest a vet";
    if (/\b\d+\s*(mg|ml|pills?|tablets?)\b/i.test(r.reply)) return "the reply gives a dose";
    return true;
  });

  await scenario("Booking a vet visit", async () => {
    const { r } = await say("Mom", "Book Mochi's checkup for next Tuesday at 10am");
    const v = visits().find((x) => x.pet === "Mochi");
    if (!v) return "no visit was booked";
    if (new Date(`${v.date}T12:00:00Z`).getUTCDay() !== 2) return `date ${v.date} is not a Tuesday`;
    if (v.time !== "10:00") return `time is ${v.time ?? "missing"}, expected 10:00`;
    if (!called(r, "add_vet_visit", "Mochi")) return "no add_vet_visit call";
    return true;
  });
} finally {
  server.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${engineLine} · ${passed}/${results.length} passed`);
for (const r of results) console.log(`  ${r.pass ? "✔" : "✗"} ${r.name}${r.pass ? "" : ` — ${r.why}`}`);
process.exit(passed === results.length ? 0 : 1);
