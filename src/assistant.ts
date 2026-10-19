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
  history?: { role: "user" | "assistant"; text: string }[];
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
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function systemPrompt(speaker: string): string {
  const { date, minutes } = localParts(now());
  return `You are Alexa, a warm, brief voice assistant in a family's home, using the PetCheck skill to help the household share pet care.
It is ${spokenDate(date)}, ${minutesToSpoken(minutes)} (time zone ${HOUSEHOLD_TZ}). Today's date is ${date}.
The person speaking right now is ${speaker}. Always pass "${speaker}" as the "by" argument when logging something they did.

PetCheck knows the household's pets and their care; you only learn about them through the tools. Never guess which pets exist or say there are none.

How to help:
- When someone says they did a pet care task ("I fed Mochi", "just walked the dog"), call log_care with the pet's name. "The dog" or "the cat" can be passed as pet "dog" or "cat"; PetCheck works out which pet that is.
- If log_care returns needs_confirmation, read its message and ask. Only call log_care again with confirm=true if they then say yes.
- "Has anyone fed the cat?" / "What's left today?" / "How's Mochi today?" → get_status. "How's Mochi doing this week?" → weekly_summary.
- If they report a task and ask a question in the same breath ("I walked Biscuit. What else does he need?"), call log_care first, then get_status, and answer from both results.
- Observations ("Mochi threw up", "Biscuit is limping") → add_note. Vet appointments → add_vet_visit (convert relative dates like "next Tuesday" to YYYY-MM-DD using today's date).
- If it's unclear which pet they mean ("I fed him" with no pet mentioned earlier), ask which pet before logging anything.

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
      if (setting !== "auto" || opts.converse || !isAccessProblem(err) || input.messages.some((m) => m.content.some((c) => "toolResult" in c))) throw err;
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

    // 2. Conversation so far (text only), then this turn.
    const messages: Message[] = [];
    for (const h of (req.history ?? []).slice(-10)) {
      if (!h.text?.trim()) continue;
      const last = messages[messages.length - 1];
      if (!last && h.role !== "user") continue; // must start with the user
      if (last && last.role === h.role) last.content.push({ text: h.text });
      else messages.push({ role: h.role, content: [{ text: h.text }] });
    }
    if (messages.length && messages[messages.length - 1].role === "user") messages.pop();
    messages.push({ role: "user", content: [{ text }] });

    // 3. Let the model call tools (via MCP) until it has an answer.
    const toolCalls: AssistantResponse["toolCalls"] = [];
    let reply = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const out = await converse({
        modelId: cfg?.model ?? "petcheck-rules",
        system: [{ text: systemPrompt(speaker) }],
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
        const r = await client.callTool({ name: toolUse.name, arguments: (toolUse.input ?? {}) as Record<string, unknown> });
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
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
