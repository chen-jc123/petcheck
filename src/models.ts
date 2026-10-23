// The language models behind the simulated Alexa+. Each protocol is wrapped as a
// ConverseFn: it takes the Bedrock Converse-shaped request the assistant loop
// builds and returns a Converse-shaped reply, so the tool loop (and every MCP call
// it makes) is the same whichever model answers.
//
//   ASSISTANT_ENGINE=openai     any OpenAI-compatible Chat Completions API
//                               OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, optional OPENAI_EXTRA_BODY (JSON;
//                               a null value removes that field, e.g. {"max_tokens":null} for reasoning models)
//   ASSISTANT_ENGINE=anthropic  any Anthropic-compatible Messages API
//                               ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, optional ANTHROPIC_EXTRA_BODY (JSON)
//
// Both work through relay ("中转站") APIs as well as the vendors' own endpoints: only the base URL changes.
//   ASSISTANT_ENGINE=bedrock    Amazon Bedrock Converse API (BEDROCK_MODEL_ID, AWS credentials)
//   ASSISTANT_ENGINE=rules      the built-in rules engine, no model
//   ASSISTANT_ENGINE=auto       (default) the first configured of openai, anthropic, bedrock,
//                               falling back to rules while that model can't be reached

import type { ContentBlock, ConverseFn, ConverseInput, Message } from "./assistant.js";

export type ModelEngine = "bedrock" | "openai" | "anthropic";

export interface ModelConfig {
  engine: ModelEngine;
  model: string;
  /** Shown in the UI next to the model name, e.g. "OpenAI-compatible API". */
  label: string;
  baseUrl?: string;
  apiKey?: string;
  extraBody?: Record<string, unknown>;
}

const LABELS: Record<ModelEngine, string> = {
  bedrock: "Amazon Bedrock",
  openai: "OpenAI-compatible API",
  anthropic: "Anthropic-compatible API",
};

/** One model call; a turn makes 2 or 3 of them, and the deployed Lambda allows 60 s (LAMBDA_TIMEOUT). */
const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 12_000);

/**
 * Sent with every Anthropic-protocol request unless ANTHROPIC_EXTRA_BODY replaces it: a spoken
 * reply can't wait for extended thinking. Right for Claude Haiku 5.5 and Qwen; Claude Sonnet 5.5
 * needs {"thinking":{"type":"between_tools"}} and Claude Opus 5.5 {"output_config":{"effort":"low"}}.
 */
const DEFAULT_ANTHROPIC_EXTRA = { thinking: { type: "disabled" } };

/** The model ASSISTANT_ENGINE selects, or undefined for the rules engine. Throws on incomplete settings. */
export function modelConfig(setting: string, env: NodeJS.ProcessEnv = process.env): ModelConfig | undefined {
  // "auto" only picks a protocol that is fully configured (key and model): a stray ANTHROPIC_API_KEY in the
  // shell, set for some other tool, must not make PetCheck fail.
  const ready = (p: string) => Boolean(env[`${p}_API_KEY`] && env[`${p}_MODEL`]);
  const engine = setting === "auto" ? (ready("OPENAI") ? "openai" : ready("ANTHROPIC") ? "anthropic" : "bedrock") : setting;
  if (engine === "rules") return undefined;
  if (engine === "bedrock") return { engine, model: env.BEDROCK_MODEL_ID ?? "us.amazon.nova-lite-v1:0", label: LABELS.bedrock };
  if (engine === "openai" || engine === "anthropic") {
    const P = engine.toUpperCase();
    const apiKey = env[`${P}_API_KEY`];
    const model = env[`${P}_MODEL`];
    if (!apiKey || !model) throw new Error(`ASSISTANT_ENGINE=${engine} needs ${P}_API_KEY and ${P}_MODEL.`);
    let extraBody: Record<string, unknown> | undefined = engine === "anthropic" ? DEFAULT_ANTHROPIC_EXTRA : undefined;
    const extra = env[`${P}_EXTRA_BODY`];
    if (extra) {
      try {
        extraBody = JSON.parse(extra);
      } catch {
        throw new Error(`${P}_EXTRA_BODY should be a JSON object, e.g. ${engine === "openai" ? `{"enable_thinking":false}` : `{"thinking":{"type":"disabled"}}`}.`);
      }
    }
    const baseUrl = env[`${P}_BASE_URL`] ?? (engine === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com");
    return { engine, model, label: LABELS[engine], baseUrl, apiKey, extraBody };
  }
  throw new Error(`ASSISTANT_ENGINE should be auto, openai, anthropic, bedrock or rules (got "${setting}").`);
}

/**
 * A model call that failed. Its name is "ModelUnavailableError" when the service can't be
 * used right now (credentials, quota, unknown model, outage, network), which lets the
 * "auto" engine fall back to rules; anything else (a request PetCheck got wrong) is
 * "ModelRequestError" and is never hidden.
 */
export class ModelError extends Error {
  constructor(
    label: string,
    readonly status: number | undefined,
    detail: string,
  ) {
    super(`${label}${status ? ` HTTP ${status}` : ""}: ${detail}`);
    const unavailable = status === undefined || [401, 402, 403, 404, 408, 429].includes(status) || status >= 500;
    this.name = unavailable ? "ModelUnavailableError" : "ModelRequestError";
  }
}

let bedrockConverse: ConverseFn | undefined;

export async function modelConverse(cfg: ModelConfig): Promise<ConverseFn> {
  if (cfg.engine === "openai") return openaiConverse({ baseUrl: cfg.baseUrl!, apiKey: cfg.apiKey!, extraBody: cfg.extraBody });
  if (cfg.engine === "anthropic") return anthropicConverse({ baseUrl: cfg.baseUrl!, apiKey: cfg.apiKey!, extraBody: cfg.extraBody });
  if (!bedrockConverse) {
    const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({});
    // Anthropic reasoning blocks in a stored conversation mean nothing to Converse.
    const converse = (input: ConverseInput) =>
      ({ ...input, messages: input.messages.map((m) => ({ ...m, content: m.content.filter((c) => !("reasoning" in c)) })) });
    bedrockConverse = (input) => client.send(new ConverseCommand(converse(input) as never)) as never;
  }
  return bedrockConverse;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible Chat Completions
// ---------------------------------------------------------------------------

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments?: string } }[];
    };
  }[];
}

export function openaiConverse(opts: { baseUrl: string; apiKey: string; extraBody?: Record<string, unknown> }): ConverseFn {
  return async (input) => {
    const body = {
      model: input.modelId,
      messages: [{ role: "system", content: systemText(input) }, ...input.messages.flatMap(toOpenAI)],
      tools: input.toolConfig.tools.map(({ toolSpec: t }) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema.json },
      })),
      max_tokens: input.inferenceConfig.maxTokens,
      temperature: input.inferenceConfig.temperature,
      ...opts.extraBody,
    };
    const res = (await postJson(`${trimSlash(opts.baseUrl)}/chat/completions`, { authorization: `Bearer ${opts.apiKey}` }, body, LABELS.openai)) as OpenAIResponse;
    const msg = res.choices?.[0]?.message;
    if (!msg) throw new ModelError(LABELS.openai, 200, "response had no message");
    const content: ContentBlock[] = [];
    if (msg.content?.trim()) content.push({ text: msg.content });
    for (const c of msg.tool_calls ?? []) {
      content.push({ toolUse: { toolUseId: c.id, name: c.function.name, input: parseArgs(c.function.arguments) } });
    }
    return { stopReason: content.some((c) => "toolUse" in c) ? "tool_use" : "end_turn", output: { message: { role: "assistant", content } } };
  };
}

function toOpenAI(m: Message): unknown[] {
  const text = textOf(m);
  if (m.role === "assistant") {
    const toolCalls = m.content.flatMap((c) =>
      "toolUse" in c
        ? [{ id: c.toolUse.toolUseId, type: "function", function: { name: c.toolUse.name, arguments: JSON.stringify(c.toolUse.input ?? {}) } }]
        : [],
    );
    return [{ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }];
  }
  // Chat Completions has no error flag on tool results, so say it in the text.
  const results = m.content.flatMap((c) =>
    "toolResult" in c
      ? [{ role: "tool", tool_call_id: c.toolResult.toolUseId, content: (c.toolResult.status === "error" ? "Error: " : "") + resultText(c) }]
      : [],
  );
  return text ? [...results, { role: "user", content: text }] : results;
}

/** Tool arguments arrive as a JSON string; a malformed one becomes {} and the MCP server's validation explains what's missing. */
function parseArgs(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Anthropic-compatible Messages
// ---------------------------------------------------------------------------

interface AnthropicResponse {
  content?: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: string })[];
}

export function anthropicConverse(opts: { baseUrl: string; apiKey: string; extraBody?: Record<string, unknown> }): ConverseFn {
  return async (input) => {
    // No temperature: current Claude models reject non-default sampling values.
    const body = {
      model: input.modelId,
      system: systemText(input),
      messages: input.messages.map(toAnthropic),
      tools: input.toolConfig.tools.map(({ toolSpec: t }) => ({ name: t.name, description: t.description, input_schema: t.inputSchema.json })),
      max_tokens: input.inferenceConfig.maxTokens,
      ...(opts.extraBody ?? DEFAULT_ANTHROPIC_EXTRA),
    };
    const res = (await postJson(
      `${trimSlash(opts.baseUrl)}/v1/messages`,
      { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
      body,
      LABELS.anthropic,
    )) as AnthropicResponse;
    const content: ContentBlock[] = [];
    for (const b of res.content ?? []) {
      if (b.type === "text" && "text" in b && b.text.trim()) content.push({ text: b.text });
      else if (b.type === "tool_use" && "id" in b) content.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input } });
      // Thinking blocks are never spoken, but go back unchanged on the next request.
      else if (b.type === "thinking" || b.type === "redacted_thinking") content.push({ reasoning: b });
    }
    return { stopReason: content.some((c) => "toolUse" in c) ? "tool_use" : "end_turn", output: { message: { role: "assistant", content } } };
  };
}

function toAnthropic(m: Message): unknown {
  return {
    role: m.role,
    content: m.content.flatMap((c): Record<string, unknown>[] => {
      if ("text" in c) return c.text.trim() ? [{ type: "text", text: c.text }] : [];
      if ("reasoning" in c) return [c.reasoning as Record<string, unknown>];
      if ("toolUse" in c) return [{ type: "tool_use", id: c.toolUse.toolUseId, name: c.toolUse.name, input: c.toolUse.input ?? {} }];
      return [{ type: "tool_result", tool_use_id: c.toolResult.toolUseId, content: resultText(c), ...(c.toolResult.status === "error" ? { is_error: true } : {}) }];
    }),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const trimSlash = (url: string) => url.replace(/\/+$/, "");
const systemText = (input: ConverseInput) => input.system.map((s) => s.text).join("\n");
const textOf = (m: Message) => m.content.flatMap((c) => ("text" in c && c.text.trim() ? [c.text] : [])).join("\n");
const resultText = (c: Extract<ContentBlock, { toolResult: unknown }>) => c.toolResult.content.map((x) => x.text).join("\n");

async function postJson(url: string, headers: Record<string, string>, body: Record<string, unknown>, label: string): Promise<unknown> {
  // A null from *_EXTRA_BODY removes a default field (reasoning models reject max_tokens and temperature).
  const sent = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(sent),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    throw new ModelError(label, undefined, e.cause?.message ?? e.message ?? "request failed");
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const error = (json as { error?: string | { message?: string } } | undefined)?.error;
    throw new ModelError(label, res.status, (typeof error === "string" ? error : error?.message) ?? text.slice(0, 200));
  }
  if (json === undefined) throw new ModelError(label, res.status, "response was not JSON");
  return json;
}
