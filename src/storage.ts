// Storage modes.
//
//   memory   — data lives in the process (default; great for local testing).
//   file     — like dynamodb, but new records are appended to a local JSON Lines file
//              (DATA_FILE, default .data/petcheck.jsonl), so local data survives restarts.
//   dynamodb — every request loads the household from DynamoDB, runs the same
//              store logic, then saves any new records. Stateless, so it works
//              on AWS Lambda where each request may hit a fresh container.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadState,
  resetStore,
  seedDemoData,
  seedTodaySoFar,
  takeChanges,
  type Alert,
  type Change,
  type CareEvent,
  type Note,
  type Pet,
  type VetVisit,
  type Kind,
} from "./store.js";
import { isDemoTime, offsetForTime, setDemoOffset } from "./clock.js";
import { seedMarket, type CareRequest, type Claim } from "./market.js";

export interface HouseholdState {
  pets: Pet[];
  events: CareEvent[];
  notes: Note[];
  visits: VetVisit[];
  alerts: Alert[];
  requests: CareRequest[];
  claims: Claim[];
}

export const emptyState = (): HouseholdState => ({ pets: [], events: [], notes: [], visits: [], alerts: [], requests: [], claims: [] });

const LISTS: Record<Kind, keyof HouseholdState> = {
  pet: "pets",
  event: "events",
  note: "notes",
  visit: "visits",
  alert: "alerts",
  request: "requests",
  claim: "claims",
};

/** Put one saved record back in its list. */
export function addRecord(state: HouseholdState, kind: Kind, item: unknown): void {
  (state[LISTS[kind]] as unknown[]).push(item);
}

/** What a persistent backend must provide (DynamoDB, or a fake in tests). */
export interface Backend {
  loadAll(): Promise<HouseholdState>;
  saveChanges(changes: Change[]): Promise<void>;
}

export interface Storage {
  mode: string;
  /** Run one tool call against up-to-date data and persist whatever it created. */
  run<T>(fn: () => T): Promise<T>;
}

export function memoryStorage(seed = true): Storage {
  if (seed) {
    seedDemoData();
    seedMarket();
  }
  // `npm run demo`: start the day tidy (everything due so far done, both dinners open).
  // DEMO_TODAY=17:35 does it as if it were 5:35 PM, for recording with /demo?time=17:40
  // (the local twin of `npm run db:demo -- 17:35`).
  const demoToday = process.env.DEMO_TODAY;
  if (seed && demoToday) {
    if (isDemoTime(demoToday)) setDemoOffset(offsetForTime(demoToday));
    seedTodaySoFar();
    setDemoOffset(0);
  }
  takeChanges(); // nothing to persist in memory mode
  return {
    mode: "memory",
    async run(fn) {
      const result = fn();
      takeChanges();
      return result;
    },
  };
}

export function persistentStorage(backend: Backend, mode: string, seedIfEmpty = true): Storage {
  // Requests are serialized within one process because the store is a shared
  // in-memory snapshot. (Lambda runs one request per container at a time anyway.)
  let queue: Promise<unknown> = Promise.resolve();

  const runOne = async <T>(fn: () => T): Promise<T> => {
    const state = await backend.loadAll();
    if (state.pets.length === 0 && seedIfEmpty) {
      resetStore();
      seedDemoData(); // records the demo pets + history as changes to save
      if (state.requests.length === 0) seedMarket(); // other households may already use the care network
    } else {
      loadState(state);
    }
    try {
      return fn();
    } finally {
      const changes = takeChanges();
      if (changes.length) await backend.saveChanges(changes);
    }
  };

  return {
    mode,
    run<T>(fn: () => T): Promise<T> {
      const next = queue.then(() => runOne(fn));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Pick the storage mode from environment variables. */
export async function createStorage(): Promise<Storage> {
  const mode = (process.env.STORAGE ?? "memory").toLowerCase();
  const seed = process.env.SEED !== "false";
  if (mode === "dynamodb") {
    const { dynamoBackend } = await import("./dynamo.js");
    return persistentStorage(dynamoBackend(), "dynamodb", seed);
  }
  if (mode === "file") return persistentStorage(fileBackend(), "file", seed);
  return memoryStorage(seed);
}

/** Local persistence: every new record is appended to a JSON Lines file, one record per line. */
export function fileBackend(path = process.env.DATA_FILE ?? ".data/petcheck.jsonl"): Backend {
  return {
    async loadAll() {
      const state = emptyState();
      let text = "";
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        if ((err as { code?: string }).code !== "ENOENT") throw err;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const { kind, item } = JSON.parse(line) as Change;
          addRecord(state, kind, item);
        } catch {
          console.warn(`${path}: skipping an unreadable line (an interrupted write?)`);
        }
      }
      return state;
    },
    async saveChanges(changes) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, changes.map((c) => JSON.stringify({ kind: c.kind, item: c.item }) + "\n").join(""));
    },
  };
}
