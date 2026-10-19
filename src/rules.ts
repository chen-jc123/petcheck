// Backup "rules" engine for the simulated Alexa+.
//
// It implements the same ConverseFn interface as the language models (models.ts), so
// it plugs into exactly the same loop: it picks a PetCheck tool, the MCP client calls
// the MCP server over HTTP, and the tool's (already spoken-friendly) result becomes the
// reply. Used when the model can't be reached (no key, account not yet allowlisted,
// outage) or when ASSISTANT_ENGINE=rules. Understands the everyday phrases PetCheck is built for.

import type { ConverseFn, ConverseInput, Message } from "./assistant.js";
import type { Activity } from "./store.js";

type ToolCall = { name: string; input: Record<string, unknown> };

/** A tool to call (and optionally a second one once it succeeds), or something to say directly. */
export type Intent = ({ kind: "tool" } & ToolCall & { then?: ToolCall }) | { kind: "say"; text: string };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Words that are never pet names. */
const STOP = new Set(
  ("i me my we our you he she it they him them the a an and or to for of on in at with just already has have had did does do is are was else " +
    "were anyone someone somebody everyone today tonight this morning evening week what what's whats who how how's hows when where " +
    "alexa please yes no yeah nope ok okay mom dad emma cat dog kitty puppy pet pets fed feed walked walk gave give took take " +
    "breakfast dinner lunch food meal medicine meds pill litter water brushed groomed bath left still need needs be been his her " +
    "their its that up threw throw vet checkup appointment next book schedule doing done let know tell about any anything all").split(" "),
);

const ACTIVITY_PATTERNS: [Activity, RegExp][] = [
  ["meds", /\b(medicine|medication|meds|pill|pills|supplement|dose|insulin|heartworm|flea)\b/],
  ["litter", /\b(litter|litterbox|litter box|scooped)\b/],
  ["walk", /\b(walk|walked|walking|took \w+ out|took \w+ for a)\b/],
  ["water", /\b(water|refilled)\b/],
  ["groom", /\b(brush|brushed|groom|groomed|bath|bathed|trimmed)\b/],
  ["feed", /\b(fed|feed|feeding|breakfast|dinner|lunch|food|meal|ate)\b/],
];

function activityOf(t: string): Activity | undefined {
  for (const [a, re] of ACTIVITY_PATTERNS) if (re.test(t)) return a;
  return undefined;
}

/** Best guess at the pet's name: a word after a care verb, "X's", or any non-stopword. */
export function petOf(text: string): string | undefined {
  const t = text.replace(/[.,!?]/g, " ");
  for (const m of t.matchAll(/\b(?:fed|feed|walked|walk|gave|give|brushed|groomed|bathed|took|for|about|did|has)\s+([A-Za-z][a-z]+)/gi)) {
    if (!STOP.has(m[1].toLowerCase())) return cap(m[1]);
  }
  for (const m of t.matchAll(/\b([A-Za-z][a-z]+)'s\b/g)) {
    if (!STOP.has(m[1].toLowerCase())) return cap(m[1]);
  }
  for (const w of t.split(/\s+/)) {
    const clean = w.replace(/'s$/i, "");
    if (clean.length >= 3 && /^[A-Za-z]+$/.test(clean) && !STOP.has(clean.toLowerCase())) return cap(clean);
  }
  // "the cat" / "the dog": the server resolves a species to the household's only pet of that kind.
  if (/\b(cat|kitty|kitten)\b/i.test(t)) return "cat";
  if (/\b(dog|puppy|pup)\b/i.test(t)) return "dog";
  return undefined;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** "next Tuesday at 10", "tomorrow at 3:30 pm", "October 6 at 10am" → {date, time}. */
export function dateTimeOf(text: string, today: string): { date?: string; time?: string } {
  const t = text.toLowerCase();
  const base = new Date(`${today}T12:00:00Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  let date: string | undefined;
  if (/\btoday\b/.test(t)) date = today;
  else if (/\btomorrow\b/.test(t)) date = iso(new Date(base.getTime() + 86_400_000));
  else {
    const wd = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (wd >= 0) {
      let diff = (wd - base.getUTCDay() + 7) % 7;
      if (diff === 0) diff = 7;
      date = iso(new Date(base.getTime() + diff * 86_400_000));
    } else {
      const m = t.match(new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})`));
      const n = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
      const month = m ? MONTHS.indexOf(m[1]) + 1 : n ? Number(n[1]) : 0;
      const day = m ? Number(m[2]) : n ? Number(n[2]) : 0;
      if (month && day) {
        let year = base.getUTCFullYear();
        const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        if (candidate < today) year++;
        date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }
  let time: string | undefined;
  const tm = t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/) ?? t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/);
  if (tm) {
    let h = Number(tm[1]);
    const min = tm[2] ?? "00";
    const ampm = tm[3]?.replace(/\./g, "");
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    if (!ampm && h >= 1 && h <= 6) h += 12; // "at 3" for a vet visit means 3 PM
    if (h <= 23) time = `${String(h).padStart(2, "0")}:${min}`;
  }
  return { date, time };
}

/** Decide what to do with one utterance. */
export function parseIntent(
  text: string,
  ctx: { speaker: string; today: string; previousReply?: string; previousUser?: string },
): Intent {
  const raw = text.trim();
  const t = raw.toLowerCase();
  const pet = petOf(raw);
  const by = ctx.speaker;

  // Answer to "Which pet? You have Mochi and Biscuit.": redo the previous request for that pet.
  if (ctx.previousReply && /^Which pet\?/.test(ctx.previousReply) && ctx.previousUser && pet && !activityOf(t)) {
    const prev = parseIntent(ctx.previousUser, { speaker: ctx.speaker, today: ctx.today });
    if (prev.kind === "tool") return { ...prev, input: { ...prev.input, pet } };
  }

  // Follow-up to a duplicate check: "Dad already fed Mochi at 7:52 AM … log it again?"
  if (ctx.previousReply && /log it again\?/i.test(ctx.previousReply)) {
    if (/^(yes|yeah|yep|yup|sure|please|do it|log it|go ahead|correct)\b/.test(t)) {
      const prevPet = ctx.previousReply.match(/(?:fed|walked|groomed|to|for)\s+([A-Z][a-z]+)\s+at\b/)?.[1];
      const prevAct = activityOf(ctx.previousReply.toLowerCase()) ?? "feed";
      return { kind: "tool", name: "log_care", input: { pet: prevPet, activity: prevAct, by, confirm: true } };
    }
    if (/^(no|nope|nah|never ?mind|don't|do not|cancel)\b/.test(t)) return { kind: "say", text: "Okay, I won't log it again." };
  }

  if (/^(hi|hello|hey|help|what can you do)\b/.test(t)) {
    return {
      kind: "say",
      text: `Hi ${by}! Tell me when you've fed, walked or given medicine to a pet, or ask what's left today or how a pet's week went.`,
    };
  }

  // Safety: PetCheck never gives veterinary advice.
  if (/\b(can (dogs?|cats?|he|she|it|they) (eat|have)|is it (safe|ok|okay)|should i (give|feed)|how much \w+ should|what dose|dosage|is (this|that) (normal|serious))\b/.test(t)) {
    return { kind: "say", text: "I can't give veterinary advice. Please check with your vet. I can note what you've noticed if you'd like." };
  }

  if (/\b(vet|checkup|check-up|check up|appointment)\b/.test(t)) {
    const { date, time } = dateTimeOf(raw, ctx.today);
    if (!date) return { kind: "say", text: "What day is the vet visit? For example, next Tuesday at 10." };
    const reason = /\bcheck ?-?up\b/.test(t) ? "checkup" : /\bvaccin/.test(t) ? "vaccines" : undefined;
    return { kind: "tool", name: "add_vet_visit", input: { pet, date, time, reason } };
  }

  // A report and a question at once: "I just walked Biscuit. What else does he need today?"
  // Log it first, then answer the question about the same pet.
  const [statement, ...rest] = raw.split(/(?<=[.!])\s+/);
  if (rest.length && /\?$/.test(raw) && activityOf(statement.toLowerCase())) {
    const first = parseIntent(statement, ctx);
    const second = parseIntent(rest.join(" "), { speaker: ctx.speaker, today: ctx.today });
    if (first.kind === "tool" && first.name === "log_care" && second.kind === "tool" && /^(get_status|weekly_summary)$/.test(second.name)) {
      return { ...first, then: { name: second.name, input: { pet: second.input.pet ?? first.input.pet } } };
    }
  }

  const isQuestion = /\?$/.test(raw) || /^(has|have|did|does|is|are|was|what|what's|whats|how|how's|hows|who|when|anything|any)\b/.test(t);
  if (isQuestion) {
    const weekly =
      /\b(week|weekly|summary)\b/.test(t) ||
      (!/\b(today|tonight)\b/.test(t) && (/\b(been doing|how('s| is| has)\s+\w+\s+(doing|been))\b/.test(t) || /^how('s| is)\b/.test(t)));
    if (weekly) return { kind: "tool", name: "weekly_summary", input: { pet } };
    return { kind: "tool", name: "get_status", input: { pet } };
  }

  // Observations: record, never interpret.
  if (/\b(threw up|throw up|throwing up|vomit\w*|sick|limp\w*|cough\w*|sneez\w*|diarrh\w*|not eating|didn't eat|ate (less|only|half)|lethargic|tired|scratch\w*|bleed\w*|seems?|looks?)\b/.test(t)) {
    return { kind: "tool", name: "add_note", input: { pet, text: raw.replace(/^(note( that)?|fyi)[:,]?\s*/i, ""), by } };
  }

  const activity = activityOf(t);
  if (activity) {
    const detail = raw.match(/\b(half a can|a can|a cup|two cups|\d+ cups?)\b/i)?.[0];
    return { kind: "tool", name: "log_care", input: { pet, activity, by, detail } };
  }

  return {
    kind: "say",
    text: "Sorry, I didn't catch that. You can say things like “I fed Mochi” or “Has anyone walked Biscuit?”",
  };
}

const lastText = (m: Message | undefined) =>
  m?.content.map((c) => ("text" in c ? c.text : "")).join(" ").trim() ?? "";

type ToolResult = Extract<Message["content"][number], { toolResult: unknown }>;

const say = (text: string) => ({ stopReason: "end_turn", output: { message: { role: "assistant" as const, content: [{ text }] } } });
const useTool = ({ name, input }: ToolCall) => ({
  stopReason: "tool_use",
  output: {
    message: {
      role: "assistant" as const,
      content: [{ toolUse: { toolUseId: `rules-${Date.now()}`, name, input: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } }],
    },
  },
});

/**
 * The ConverseFn: round 1 picks a tool (or answers directly); once the tool results are
 * back it calls the follow-up tool, if any, then speaks the results.
 */
export const rulesConverse: ConverseFn = async (input: ConverseInput) => {
  const msgs = input.messages;
  // This turn's utterance is the last user message with text; tool results come after it.
  const lastOf = (list: Message[], role: Message["role"]) => [...list].reverse().find((m) => m.role === role);
  const utterance = [...msgs].reverse().find((m) => m.role === "user" && m.content.some((c) => "text" in c));
  const at = utterance ? msgs.lastIndexOf(utterance) : msgs.length;
  const previousReply = lastText(lastOf(msgs.slice(0, at), "assistant"));
  const previousUser = lastText(lastOf(msgs.slice(0, Math.max(at - 1, 0)), "user"));

  const sys = input.system[0]?.text ?? "";
  const speaker = sys.match(/The person speaking right now is ([^.\n]+)\./)?.[1] ?? "Someone";
  const today = sys.match(/Today's date is (\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
  const intent = parseIntent(lastText(utterance), { speaker, today, previousReply, previousUser });

  const results = msgs
    .slice(at + 1)
    .flatMap((m) => m.content.filter((c): c is ToolResult => "toolResult" in c))
    .map((c) => ({ text: c.toolResult.content[0]?.text ?? "", failed: c.toolResult.status === "error" }));
  if (results.length) {
    // Stop at an error or a duplicate question; otherwise run the follow-up tool once.
    const done = results.some((r) => r.failed || /log it again\?/i.test(r.text));
    if (intent.kind === "tool" && intent.then && results.length === 1 && !done) return useTool(intent.then);
    return say(results.map((r) => r.text).join(" "));
  }

  return intent.kind === "say" ? say(intent.text) : useTool(intent);
};
