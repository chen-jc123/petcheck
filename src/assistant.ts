// The "simulated Alexa+" brain: Amazon Bedrock (Converse API with tool use) +
// a real MCP client that calls the PetCheck MCP server over HTTP.
//
//   browser ──text──▶ POST /api/assistant ──▶ Bedrock decides which tool to use
//                                            ──▶ MCP client ──HTTPS──▶ /mcp (PetCheck)
//                                            ◀── tool result ◀──────────┘
//   browser ◀──reply + trace of every MCP HTTP request/response
//
// The MCP server is always reached over HTTP, exactly like Alexa+ would reach
// it. Nothing here imports the tool code directly.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { HOUSEHOLD_TZ, now, spokenDate, localParts, minutesToSpoken } from "./clock.js";
import { rulesConverse } from "./rules.js";

export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.amazon.nova-lite-v1:0";
/**
 * ASSISTANT_ENGINE: "auto" (default) uses Bedrock and falls back to the rules engine if
 * the account can't call Bedrock yet; "bedrock" never falls back; "rules" skips Bedrock.
 */
const ENGINE = (process.env.ASSISTANT_ENGINE ?? "auto").toLowerCase();
/** After Bedrock refuses access, skip it for a while instead of paying the latency each turn. */
const BEDROCK_RETRY_MS = 10 * 60_000;
let bedrockBlockedUntil = 0;
let bedrockBlockedReason = "";

/** Errors that mean "this account/model can't use Bedrock right now" (not a bug in our request). */
function isAccessProblem(err: unknown): boolean {
  const e = err as { name?: string; message?: string };
  return (
    /AccessDenied|UnrecognizedClient|ResourceNotFound|ValidationException/i.test(e?.name ?? "") &&
    /access|verify|allowlist|not authorized|model|subscription|identifier/i.test(e?.message ?? "")
  );
}
const MAX_TOOL_ROUNDS = 5;

// ---------------------------------------------------------------------------
// Types (a small subset of the Bedrock Converse API)
// ---------------------------------------------------------------------------

type ContentBlock =
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
  /** "bedrock" or "rules" — which engine produced this turn. */
  engine: "bedrock" | "rules";
  /** Why the rules engine was used, if Bedrock was skipped. */
  engineNote?: string;
  model: string;
  ms: number;
  toolCalls: { name: string; input: unknown; result: string; isError: boolean }[];
  trace: TraceEntry[];
}

// ---------------------------------------------------------------------------
// Bedrock
// ---------------------------------------------------------------------------

let bedrockConverse: ConverseFn | undefined;

async function realConverse(): Promise<ConverseFn> {
  if (!bedrockConverse) {
    const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({});
    bedrockConverse = (input) => client.send(new ConverseCommand(input as never)) as Promise<ConverseOutput>;
  }
  return bedrockConverse;
}

function systemPrompt(speaker: string): string {
  const { date, minutes } = localParts(now());
  return `You are Alexa, a warm, brief voice assistant in a family's home, using the PetCheck skill to help the household share pet care.
It is ${spokenDate(date)}, ${minutesToSpoken(minutes)} (time zone ${HOUSEHOLD_TZ}). Today's date is ${date}.
The person speaking right now is ${speaker}. Always pass "${speaker}" as the "by" argument when logging something they did.

How to help:
- When someone says they did a pet care task ("I fed Mochi", "just walked the dog"), call log_care.
- If log_care returns needs_confirmation, read its message and ask. Only call log_care again with confirm=true if they then say yes.
- "Has anyone fed the cat?" / "What's left today?" → get_status. "How's Mochi doing this week?" → weekly_summary.
- Observations ("Mochi threw up", "Biscuit is limping") → add_note. Vet appointments → add_vet_visit (convert relative dates like "next Tuesday" to YYYY-MM-DD using today's date).
- If the pet isn't named and it's ambiguous, ask which pet.

How to speak:
- Reply in 1–2 short spoken sentences. No lists, markdown, emojis or URLs.
- Base answers only on tool results; never invent care history.
- Never give veterinary advice (symptoms, doses, food safety, treatment). Record notes, then suggest checking with a vet.`;
}

/** Nova models sometimes wrap reasoning in <thinking> tags; never speak those. */
function cleanReply(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\/?response>/gi, "")
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
    /** Force this model function for the whole turn (tests). */
    converse?: ConverseFn;
    /** Stand-in for Bedrock that still gets the auto-fallback behaviour (tests). */
    bedrock?: ConverseFn;
  },
): Promise<AssistantResponse> {
  const t0 = Date.now();
  const text = (req.text ?? "").trim().slice(0, 500);
  if (!text) throw new Error("Say something first.");
  const speaker = (req.speaker ?? "Someone").trim().slice(0, 40) || "Someone";

  // Pick the engine. A converse function passed in (tests) always wins.
  let engine: "bedrock" | "rules" = "bedrock";
  let engineNote: string | undefined;
  if (!opts.converse && (ENGINE === "rules" || (ENGINE === "auto" && Date.now() < bedrockBlockedUntil))) {
    engine = "rules";
    engineNote = ENGINE === "rules" ? "rules engine selected" : `Bedrock unavailable: ${bedrockBlockedReason}`;
  }
  const bedrock = opts.converse ?? opts.bedrock ?? (engine === "bedrock" ? await realConverse() : rulesConverse);
  const converse: ConverseFn = async (input) => {
    if (engine === "rules") return rulesConverse(input);
    try {
      return await bedrock(input);
    } catch (err) {
      // Only switch before any tool ran in this turn, and only for access problems.
      if (ENGINE !== "auto" || opts.converse || !isAccessProblem(err) || input.messages.some((m) => m.content.some((c) => "toolResult" in c))) throw err;
      const e = err as { name?: string; message?: string };
      bedrockBlockedUntil = Date.now() + BEDROCK_RETRY_MS;
      bedrockBlockedReason = `${e.name}: ${(e.message ?? "").slice(0, 120)}`;
      console.warn("Bedrock unavailable, using rules engine:", bedrockBlockedReason);
      engine = "rules";
      engineNote = `Bedrock unavailable: ${bedrockBlockedReason}`;
      return rulesConverse(input);
    }
  };

  // 1. Connect to the PetCheck MCP server over HTTP (initialize + tools/list).
  const trace: TraceEntry[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(opts.mcpUrl), {
    requestInit: { headers: opts.apiKey ? { "x-api-key": opts.apiKey } : {} },
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
        modelId: MODEL_ID,
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
      engineNote,
      model: engine === "rules" ? "petcheck-rules" : MODEL_ID,
      ms: Date.now() - t0,
      toolCalls,
      trace,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}
