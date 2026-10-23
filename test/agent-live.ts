// Acceptance run against the REAL configured model (reads .env; see .env.example):
// the household and care network scenarios, each on fresh demo data, through the real
// MCP client and server, with conversations kept server-side (sessions) as on the page.
// Prints every turn, the tool calls and the data changes.
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
const { householdRequests, postCareRequest, seedMarket } = await import("../src/market.js");
const { offsetForTime, setDemoOffset, withDemoTime } = await import("../src/clock.js");
/** Every scenario runs on the demo clock at 5:40 PM, so results don't depend on when the suite runs. */
const DEMO_TIME = "17:40";
type Reply = Awaited<ReturnType<typeof runAssistant>>;
/** A conversation on one device, kept server-side. */
type History = { sessionId: string };
type Device = { role?: "household" | "sitter"; location?: { lat: number; lng: number; label?: string } };
/** Sam the pet sitter's phone, in Kerrytown (about 0.4 miles from the household). */
const SAMS_PHONE: Device = { role: "sitter", location: { lat: 42.286, lng: -83.747, label: "Kerrytown" } };

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const mcpUrl = `http://localhost:${(server.address() as AddressInfo).port}/mcp`;

/** Fresh household for every scenario: last week's history, today tidy up to now, dinners still open. */
function freshDay() {
  setDemoOffset(offsetForTime("17:35"));
  seedDemoData();
  seedMarket();
  seedTodaySoFar();
  setDemoOffset(0);
  takeChanges();
}
const events = () => todayView().events;
const visits = () => todayView().upcomingVisits;

let engineLine = "";
let conversations = 0;
/** One spoken turn; continues `history`'s conversation, or starts a new one. */
async function say(speaker: string, text: string, history?: History, device: Device = {}): Promise<{ r: Reply; history: History }> {
  const sessionId = history?.sessionId ?? `live-${Date.now()}-${++conversations}`;
  const r = await withDemoTime(DEMO_TIME, () =>
    runAssistant({ text, speaker, sessionId, ...device }, { mcpUrl, apiKey: "live-test", demoTime: DEMO_TIME }),
  );
  engineLine ||= `${r.engineLabel} · ${r.model}`;
  const tools = r.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.input)})${t.isError ? " ✗" : ""}`).join(" → ") || "(none)";
  console.log(`  ${speaker}: “${text}”\n    → ${r.reply}\n    tools: ${tools} · ${r.engine} · ${r.ms} ms`);
  return { r, history: { sessionId } };
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

  await scenario("Duplicate on a shared device: confirm and cancel", async () => {
    // Dad and Emma talk to the same kitchen device, so they share one conversation.
    const dad = await say("Dad", "I fed Mochi");
    const afterDad = events().length;
    const dup = await say("Emma", "I fed Mochi", dad.history);
    const asked = dup.r.toolCalls.some((t) => t.name === "log_care" && /log it again\?/.test(t.result));
    if (!asked || events().length !== afterDad || !/\?/.test(dup.r.reply)) return "Emma got no duplicate question (or it was logged anyway)";
    if (/\b(sorry|mistake|apolog)/i.test(dup.r.reply)) return "Alexa thought Dad's line was Emma's (apologized)";
    const no = await say("Emma", "No, never mind", dup.history);
    if (events().length !== afterDad) return "logged after she said no";
    const dup2 = await say("Emma", "I fed Mochi", no.history);
    await say("Emma", "Yes, log it", dup2.history);
    // On the demo clock both feedings can share a timestamp, so look for Emma's rather than the newest.
    if (events().length !== afterDad + 1 || !events().some((e) => e.pet === "Mochi" && e.activity === "feed" && e.by === "Emma")) {
      return "no log for Emma after she said yes";
    }
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

  await scenario("Pronoun from an earlier turn", async () => {
    const before = events().length;
    const a = await say("Mom", "What's left for Mochi today?");
    const b = await say("Mom", "OK, I just gave her dinner.", a.history);
    if (!called(a.r, "get_status", "Mochi")) return "no status lookup for Mochi";
    if (!called(b.r, "log_care", "Mochi")) return "“her” wasn't resolved to Mochi from the previous turn";
    if (!events().slice(0, events().length - before).some((e) => e.pet === "Mochi" && e.activity === "feed" && e.by === "Mom")) return "no stored feeding of Mochi by Mom";
    return true;
  });

  await scenario("Post a care request: draft, then confirm", async () => {
    const a = await say("Mom", "We're away this coming Saturday and Sunday. Can you find someone to walk Biscuit twice a day?");
    const draft = a.r.toolCalls.find((t) => t.name === "post_care_request");
    if (!draft) return "no post_care_request";
    if ((draft.input as { confirm?: boolean }).confirm) return "posted without reading the draft back first";
    if (householdRequests().length) return "the draft was published before they said yes";
    if (!/\?/.test(a.r.reply)) return "didn't ask whether to post it";
    const b = await say("Mom", "Yes, post it.", a.history);
    const [req] = householdRequests();
    if (!req) return "nothing posted after yes";
    if (req.service !== "walk" || req.pets.map((p) => p.name).join() !== "Biscuit") return `wrong form: ${req.service} for ${req.pets.map((p) => p.name)}`;
    const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
    if (weekday(req.startDate) !== 6 || weekday(req.endDate) !== 0) return `dates ${req.startDate}–${req.endDate} aren't a Saturday–Sunday`;
    if (req.times.length !== 2) return `${req.times.length} visits a day, expected 2`;
    if (!called(b.r, "post_care_request")) return "the confirming call failed";
    return true;
  });

  await scenario("Sitter finds and takes a job, then logs a visit", async () => {
    // The household needs an evening walk today; Sam is free tonight.
    const posted = postCareRequest({ pets: ["Biscuit"], service: "walk", start_date: todayView().date, times: ["18:00"], by: "Mom", confirm: true });
    takeChanges();
    const a = await say("Sam", "Any dog walking jobs near me today? At least $20 a visit.", undefined, SAMS_PHONE);
    const find = a.r.toolCalls.find((t) => t.name === "find_care_requests");
    if (!find) return "no find_care_requests";
    if (!find.result.includes(posted.request.code)) return `the household's request ${posted.request.code} wasn't found`;
    if (!/Biscuit/.test(a.r.reply)) return "Biscuit's job wasn't read back";
    const b = await say("Sam", "Great, I'll take the one for Biscuit.", a.history, SAMS_PHONE);
    if (!b.r.toolCalls.some((t) => t.name === "accept_care_request" && !t.isError)) return "no accept_care_request";
    const req = householdRequests().find((r) => r.code === posted.request.code);
    if (req?.state !== "taken" || req.sitter !== "Sam") return "the request isn't taken by Sam";
    const before = events().length;
    const c = await say("Sam", "I just walked Biscuit.", b.history, SAMS_PHONE);
    if (!called(c.r, "log_care", "Biscuit")) return "the visit wasn't logged";
    if (!events().slice(0, events().length - before).some((e) => e.pet === "Biscuit" && e.activity === "walk" && e.by === "Sam")) return "no stored walk by Sam";
    return true;
  });

  await scenario("Household asks who took the request", async () => {
    const posted = postCareRequest({ pets: ["Biscuit"], service: "walk", start_date: todayView().date, by: "Mom", confirm: true });
    const { acceptCareRequest } = await import("../src/market.js");
    acceptCareRequest({ code: posted.request.code, sitter: "Sam" });
    takeChanges();
    const { r } = await say("Dad", "Has anyone taken our request for Biscuit yet?");
    if (!r.toolCalls.some((t) => t.name === "care_request_status" && !t.isError)) return "no care_request_status";
    if (!/\bSam\b/.test(r.reply)) return "didn't say Sam took it";
    return true;
  });
} finally {
  server.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${engineLine} · ${passed}/${results.length} passed`);
for (const r of results) console.log(`  ${r.pass ? "✔" : "✗"} ${r.name}${r.pass ? "" : ` — ${r.why}`}`);
process.exit(passed === results.length ? 0 : 1);
