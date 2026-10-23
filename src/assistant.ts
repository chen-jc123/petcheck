// The "simulated Alexa+" brain: a tool-calling language model (OpenAI- or
// Anthropic-compatible API, or Amazon Bedrock; see models.ts) + a real MCP client
// that calls the PetCheck MCP server over HTTP.
//
//   browser ──text──▶ POST /api/assistant ──▶ the model decides which tool to use
//                                            ──▶ MCP client ──HTTPS──▶ /mcp (PetCheck)
//                                            ◀── tool result ◀──────────┘
//   browser ◀──reply + trace of every MCP HTTP request/response
//
// The MCP server is always reached over HTTP, exactly like Alexa+ would reach
// it. Nothing here imports the tool code directly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HOUSEHOLD_TZ, now, spokenDate, localParts, minutesToSpoken } from "./clock.js";
import { modelConfig, modelConverse, type ModelEngine } from "./models.js";
import { rulesConverse } from "./rules.js";
import { isSessionId, sessions } from "./sessions.js";

/** After the model service refuses us, skip it for a while instead of paying the latency each turn. */
const MODEL_RETRY_MS = 10 * 60_000;
let modelBlockedUntil = 0;
let modelBlockedReason = "";

/** Errors that mean "this account can't use the model right now" (not a bug in our request). */
function isAccessProblem(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  if (e?.name === "ModelUnavailableError") return true;
  return (
    /AccessDenied|UnrecognizedClient|ResourceNotFound|ValidationException/i.test(e?.name ?? "") &&
    /access|verify|allowlist|not authorized|model|subscription|identifier/i.test(e?.message ?? "")
  );
}
const MAX_TOOL_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Types (a small subset of the Bedrock Converse API)
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { text: string }
  /** A model's reasoning block (Anthropic thinking), kept as-is so it can go back unchanged. */
  | { reasoning: unknown }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: { text: string }[]; status?: "success" | "error" } };

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ConverseInput {
  modelId: string;
  system: { text: string }[];
  messages: Message[];
  toolConfig: { tools: { toolSpec: { name: string; description?: string; inputSchema: { json: unknown } } }[] };
  inferenceConfig: { maxTokens: number; temperature: number };
}

export interface ConverseOutput {
  output?: { message?: Message };
  stopReason?: string;
}

/** Anything that behaves like Bedrock's Converse call (the real one, or a scripted fake in tests). */
export type ConverseFn = (input: ConverseInput) => Promise<ConverseOutput>;

export interface TraceEntry {
  kind: "mcp";
  method: string; // JSON-RPC method, e.g. tools/call
  tool?: string;
  url: string;
  status: number;
  ms: number;
  request: unknown;
  response: unknown;
}

export interface AssistantRequest {
  text: string;
  speaker?: string;
  /** "sitter": a pet sitter using the care network; otherwise a household member. */
  role?: "household" | "sitter";
  /**
   * The conversation on this device. With it, PetCheck keeps the previous turns (tool calls and
   * results included) server-side; without it, `history` (text only) is used.
   */
  sessionId?: string;
  history?: { role: "user" | "assistant"; text: string }[];
  /** Where the device is (browser geolocation or a preset), forwarded to the MCP server. */
  location?: { lat: number; lng: number; label?: string };
}

export interface AssistantResponse {
  reply: string;
  speaker: string;
  /** Which engine produced this turn. */
  engine: ModelEngine | "rules";
  /** e.g. "OpenAI-compatible API" or "Rules engine". */
  engineLabel: string;
  /** Why the rules engine was used, if the model was skipped. */
  engineNote?: string;
  model: string;
  ms: number;
  toolCalls: { name: string; input: unknown; result: string; isError: boolean }[];
  trace: TraceEntry[];
  /** Set when the conversation is kept server-side. */
  sessionId?: string;
  /** Earlier turns sent to the model with this one. */
  turnsInContext: number;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function systemPrompt(speaker: string, role: "household" | "sitter"): string {
  const { date, minutes } = localParts(now());
  const intro =
    role === "sitter"
      ? `You are Alexa, a warm, brief voice assistant, using the PetCheck skill. The person speaking right now is ${speaker}, a pet sitter who uses PetCheck's care network to find jobs; they are not part of a household.

How to help a sitter:
- "Find me jobs…" → find_care_requests with what they said (distance in miles, services, kinds of pets they take, days, minimum pay) and sitter="${speaker}". Read back the best one or two briefly with their codes.
- When they choose one ("take the first one", "I'll do R-1037") → accept_care_request with its code and sitter="${speaker}".
- "What are my bookings?" → care_request_status with sitter="${speaker}".
- When they report a visit for a household that booked them ("I walked Biscuit") → log_care with by="${speaker}".`
      : `You are Alexa, a warm, brief voice assistant in a family's home, using the PetCheck skill to help the household share pet care. The person speaking right now is ${speaker}.`;
  return `${intro}
It is ${spokenDate(date)}, ${minutesToSpoken(minutes)} (time zone ${HOUSEHOLD_TZ}). Today's date is ${date}.
Each line from a person starts with their name ("Emma: I fed Mochi"); earlier lines in the conversation may be from other people on this device. Always pass "${speaker}" as the "by" argument when logging something they did.

PetCheck knows the household's pets and their care; you only learn about them through the tools. Never guess which pets exist or say there are none.

How to help:
- When someone says they did a pet care task ("I fed Mochi", "just walked the dog"), call log_care with the pet's name. If they report it without saying who did it ("Mochi has had her breakfast"), it was the speaker. "The dog" or "the cat" can be passed as pet "dog" or "cat"; PetCheck works out which pet that is.
- If log_care returns needs_confirmation, read its message and ask. Only call log_care again with confirm=true if they then say yes.
- "Has anyone fed the cat?" / "What's left today?" / "How's Mochi today?" → get_status. "How's Mochi doing this week?" → weekly_summary.
- If they report a task and ask a question in the same breath ("I walked Biscuit. What else does he need?"), call log_care first, then get_status, and answer from both results.
- Observations ("Mochi threw up", "Biscuit is limping") → add_note. Vet appointments → add_vet_visit (convert relative dates like "next Tuesday" to YYYY-MM-DD using today's date).
- If it's unclear which pet they mean ("I fed him" with no pet mentioned earlier), ask which pet before logging anything.
- If nobody at home can do it ("we're away this weekend, can someone walk Biscuit?"), use post_care_request. Fill in only what they said (pets, service, dates as YYYY-MM-DD, times, pay); PetCheck suggests the usual times and the typical local rate, and takes the location from this device, so never ask for an address. Call it without confirm, read the draft back briefly, and call it again with the same arguments and confirm=true only after they say yes. "Has anyone taken our request?" → care_request_status.

How to speak:
- Reply in 1–2 short spoken sentences. No lists, markdown, emojis or URLs.
- Base answers only on tool results from this turn; never invent care history. Every question about a pet's care, including follow-ups like "How about Biscuit?", needs a fresh get_status or weekly_summary call. Earlier replies in the conversation are not data.
- If a tool returns an error, say plainly what went wrong. Never say something was logged or scheduled unless the tool succeeded.
- Never give veterinary advice (symptoms, doses, food safety, treatment) and never log a dose they are only asking about. Suggest checking with a vet; offer to note what they've noticed.`;
}

/** Models sometimes wrap reasoning in <thinking>/<think> tags or add markdown and emojis; never speak those. */
function cleanReply(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<\/?response>/gi, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The page's text-only history as messages: alternating, starting with the user, ending with Alexa. */
function textHistory(history: AssistantRequest["history"]): Message[] {
  const messages: Message[] = [];
  for (const h of (history ?? []).slice(-10)) {
    if (!h.text?.trim()) continue;
    const last = messages[messages.length - 1];
    if (!last && h.role !== "user") continue; // must start with the user
    if (last && last.role === h.role) last.content.push({ text: h.text });
    else messages.push({ role: h.role, content: [{ text: h.text }] });
  }
  if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
  return messages;
}

/**
 * What to keep for the next turn, ending with Alexa's answer and keeping roles alternating.
 * Messages go back as they came (reasoning blocks must not be edited); only a turn that ended
 * without an answer the model can see gets the spoken reply added.
 */
function sessionTail(messages: Message[], reply: string): Message[] {
  const last = messages[messages.length - 1];
  const answer: Message = { role: "assistant", content: [{ text: reply }] };
  if (last?.role !== "assistant") return [...messages, answer]; // stopped after tool results
  if (last.content.some((c) => "toolUse" in c)) return [...messages.slice(0, -1), answer]; // out of tool rounds: unanswered calls can't go back
  if (last.content.some((c) => "text" in c)) return messages;
  return [...messages.slice(0, -1), { role: "assistant", content: [...last.content, { text: reply }] }]; // reasoning only
}

/** The device location for the MCP server (see location.ts). */
function locationHeaders(loc: AssistantRequest["location"]): Record<string, string> {
  if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return {};
  return {
    "x-petcheck-location": `${loc.lat},${loc.lng}`,
    ...(loc.label ? { "x-petcheck-location-label": encodeURIComponent(loc.label.slice(0, 60)) } : {}),
  };
}

// ---------------------------------------------------------------------------
// MCP client with a traced fetch
// ---------------------------------------------------------------------------

function tryJson(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function tracedFetch(trace: TraceEntry[]): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const t0 = Date.now();
    const res = await fetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const request = tryJson(init?.body);
      const rpc = request as { method?: string; params?: { name?: string } };
      let response: unknown = null;
      try {
        response = tryJson(await res.clone().text());
      } catch {
        /* streaming body; leave null */
      }
      trace.push({
        kind: "mcp",
        method: rpc?.method ?? "?",
        tool: rpc?.params?.name,
        url: String(input instanceof Request ? input.url : input),
        status: res.status,
        ms: Date.now() - t0,
        request,
        response,
      });
    }
    return res;
  };
}

// ---------------------------------------------------------------------------
// The assistant turn
// ---------------------------------------------------------------------------

export async function runAssistant(
  req: AssistantRequest,
  opts: {
    mcpUrl: string;
    apiKey?: string;
    /** Demo clock ("17:40"), forwarded to the MCP server as x-petcheck-demo-time. */
    demoTime?: string;
    /** Force this model function for the whole turn (tests). */
    converse?: ConverseFn;
    /** Stand-in for the configured model that still gets the auto-fallback behaviour (tests). */
    model?: ConverseFn;
  },
): Promise<AssistantResponse> {
  const t0 = Date.now();
  const text = (req.text ?? "").trim().slice(0, 500);
  if (!text) throw new Error("Say something first.");
  const speaker = (req.speaker ?? "Someone").trim().slice(0, 40) || "Someone";
  const role = req.role === "sitter" ? "sitter" : "household";
  /** Where this turn's messages start (earlier turns come from the session). */
  let turnStart = 0;

  // Pick the engine (see models.ts). A converse function passed in (tests) always wins.
  const setting = (process.env.ASSISTANT_ENGINE ?? "auto").toLowerCase();
  const cfg = modelConfig(setting);
  let engine: ModelEngine | "rules" = cfg?.engine ?? "rules";
  let engineNote: string | undefined;
  if (!opts.converse && (!cfg || (setting === "auto" && Date.now() < modelBlockedUntil))) {
    engine = "rules";
    engineNote = !cfg ? "rules engine selected" : `${cfg.label} unavailable: ${modelBlockedReason}`;
  }
  const model = opts.converse ?? opts.model ?? (engine === "rules" ? rulesConverse : await modelConverse(cfg!));
  const converse: ConverseFn = async (input) => {
    if (engine === "rules" && !opts.converse) return rulesConverse(input);
    try {
      return await model(input);
    } catch (err) {
      // Only switch before any tool ran in this turn, and only for access problems.
      const toolRan = input.messages.slice(turnStart).some((m) => m.content.some((c) => "toolResult" in c));
      if (setting !== "auto" || opts.converse || !isAccessProblem(err) || toolRan) throw err;
      const e = err as { name?: string; message?: string };
      modelBlockedUntil = Date.now() + MODEL_RETRY_MS;
      modelBlockedReason = `${e.name}: ${(e.message ?? "").slice(0, 120)}`;
      console.warn(`${cfg!.label} unavailable, using rules engine:`, modelBlockedReason);
      engine = "rules";
      engineNote = `${cfg!.label} unavailable: ${modelBlockedReason}`;
      return rulesConverse(input);
    }
  };

  // 1. Connect to the PetCheck MCP server over HTTP (initialize + tools/list).
  const trace: TraceEntry[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(opts.mcpUrl), {
    requestInit: {
      headers: {
        ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}),
        ...(opts.demoTime ? { "x-petcheck-demo-time": opts.demoTime } : {}),
        ...locationHeaders(req.location),
      },
    },
    fetch: tracedFetch(trace),
  });
  const client = new Client({ name: "petcheck-alexa-sim", version: "0.1.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const toolConfig = {
      tools: tools.map((t) => {
        const { $schema: _ignored, ...schema } = (t.inputSchema ?? { type: "object" }) as Record<string, unknown>;
        return { toolSpec: { name: t.name, description: t.description ?? t.title ?? t.name, inputSchema: { json: schema } } };
      }),
    };

    // 2. Conversation so far (the stored session, or the page's text history), then this turn.
    const sessionId = isSessionId(req.sessionId) ? req.sessionId : undefined;
    const store = sessionId ? await sessions() : undefined;
    const messages: Message[] = store ? await store.load(sessionId!) : textHistory(req.history);
    const turnsInContext = messages.filter((m) => m.role === "user" && m.content.some((c) => "text" in c)).length;
    turnStart = messages.length;
    // Who said it, as part of the line: on a shared device, earlier lines may be someone else's.
    messages.push({ role: "user", content: [{ text: `${speaker}: ${text}` }] });

    // 3. Let the model call tools (via MCP) until it has an answer.
    const toolCalls: AssistantResponse["toolCalls"] = [];
    /** Tools that asked for confirmation this turn. */
    const awaitingAnswer = new Set<string>();
    let reply = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const out = await converse({
        modelId: cfg?.model ?? "petcheck-rules",
        system: [{ text: systemPrompt(speaker, role) }],
        messages,
        toolConfig,
        inferenceConfig: { maxTokens: 400, temperature: 0.2 },
      });
      const msg = out.output?.message;
      if (!msg) break;
      messages.push(msg);
      const uses = msg.content.filter((c): c is Extract<ContentBlock, { toolUse: unknown }> => "toolUse" in c);
      if (out.stopReason !== "tool_use" || uses.length === 0 || round === MAX_TOOL_ROUNDS) {
        reply = msg.content
          .filter((c): c is { text: string } => "text" in c)
          .map((c) => c.text)
          .join(" ");
        break;
      }
      const results: ContentBlock[] = [];
      for (const { toolUse } of uses) {
        const args = (toolUse.input ?? {}) as Record<string, unknown>;
        // A confirmation has to come from the person: a tool that asked for one this turn can't be
        // confirmed until they reply (some models post a draft and confirm it in the same breath).
        if (args.confirm === true && awaitingAnswer.has(toolUse.name)) {
          const resultText = "Not done: they haven't answered yet. Ask them, and confirm only after they say yes in their reply.";
          toolCalls.push({ name: toolUse.name, input: toolUse.input, result: resultText, isError: true });
          results.push({ toolResult: { toolUseId: toolUse.toolUseId, content: [{ text: resultText }], status: "error" } });
          continue;
        }
        const r = await client.callTool({ name: toolUse.name, arguments: args });
        if ((r.structuredContent as { status?: string } | undefined)?.status === "needs_confirmation") awaitingAnswer.add(toolUse.name);
        const resultText = ((r.content as { type: string; text?: string }[]) ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        toolCalls.push({ name: toolUse.name, input: toolUse.input, result: resultText, isError: Boolean(r.isError) });
        results.push({
          toolResult: { toolUseId: toolUse.toolUseId, content: [{ text: resultText || "(no result)" }], status: r.isError ? "error" : "success" },
        });
      }
      messages.push({ role: "user", content: results });
    }

    reply = cleanReply(reply) || (toolCalls.length ? toolCalls[toolCalls.length - 1].result : "Sorry, I didn't catch that.");
    if (store) await store.save(sessionId!, sessionTail(messages, reply));
    return {
      reply,
      speaker,
      engine,
      engineLabel: engine === "rules" ? "Rules engine" : cfg!.label,
      engineNote,
      model: engine === "rules" ? "petcheck-rules" : cfg!.model,
      ms: Date.now() - t0,
      toolCalls,
      trace,
      sessionId,
      turnsInContext,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
