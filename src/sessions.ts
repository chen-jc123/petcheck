// Conversation memory for the simulated Alexa+. (Real Alexa+ keeps its own; the PetCheck
// MCP server stays stateless either way.) One session per conversation on a device: the
// full messages of the last few turns, tool calls and their results included, so a
// follow-up like "How about Biscuit?" or a "yes" to a duplicate check has the context it
// needs. Idle for 30 minutes means a new conversation, like Alexa.
//
// Stored like the household data (STORAGE): in memory, as files in .data/sessions/, or in
// DynamoDB (pk SESSION#<id>, with a ttl attribute for cleanup).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "./assistant.js";

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_TURNS = 8;

export interface SessionStore {
  load(id: string): Promise<Message[]>;
  save(id: string, messages: Message[]): Promise<void>;
}

/** Session ids come from the browser: letters, digits, - and _ only (they become file names). */
export const isSessionId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);

interface Saved {
  updatedAt: number;
  messages: Message[];
}
const unlessIdle = (s: Saved | undefined) => (s && Date.now() - s.updatedAt < SESSION_IDLE_MS ? s.messages : []);

/** The last `turns` turns; a turn starts at a user message with text (not a tool result). */
export function lastTurns(messages: Message[], turns = SESSION_TURNS): Message[] {
  const starts = messages.flatMap((m, i) => (m.role === "user" && m.content.some((c) => "text" in c) ? [i] : []));
  if (!starts.length) return [];
  return messages.slice(starts[Math.max(starts.length - turns, 0)]);
}

function memorySessions(): SessionStore {
  const saved = new Map<string, Saved>();
  return {
    async load(id) {
      return unlessIdle(saved.get(id));
    },
    async save(id, messages) {
      saved.set(id, { updatedAt: Date.now(), messages: lastTurns(messages) });
    },
  };
}

function fileSessions(dir = process.env.SESSIONS_DIR ?? ".data/sessions"): SessionStore {
  const file = (id: string) => join(dir, `${id}.json`);
  return {
    async load(id) {
      try {
        return unlessIdle(JSON.parse(await readFile(file(id), "utf8")) as Saved);
      } catch {
        return [];
      }
    },
    async save(id, messages) {
      await mkdir(dir, { recursive: true });
      await writeFile(file(id), JSON.stringify({ updatedAt: Date.now(), messages: lastTurns(messages) } satisfies Saved));
    },
  };
}

async function dynamoSessions(): Promise<SessionStore> {
  const { doc, TABLE_NAME } = await import("./dynamo.js");
  const { GetCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const key = (id: string) => ({ pk: `SESSION#${id}`, sk: "S" });
  return {
    async load(id) {
      const res = await doc.send(new GetCommand({ TableName: TABLE_NAME, Key: key(id) }));
      const item = res.Item as { updatedAt?: number; messages?: string } | undefined;
      return item?.messages ? unlessIdle({ updatedAt: item.updatedAt ?? 0, messages: JSON.parse(item.messages) }) : [];
    },
    async save(id, messages) {
      const updatedAt = Date.now();
      await doc.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: { ...key(id), kind: "session", updatedAt, messages: JSON.stringify(lastTurns(messages)), ttl: Math.floor(updatedAt / 1000) + 86_400 },
        }),
      );
    },
  };
}

let store: Promise<SessionStore> | undefined;

/** The session store for this storage mode (created once). */
export function sessions(): Promise<SessionStore> {
  store ??= (async () => {
    const mode = (process.env.STORAGE ?? "memory").toLowerCase();
    if (mode === "dynamodb") return dynamoSessions();
    if (mode === "file") return fileSessions();
    return memorySessions();
  })();
  return store;
}
