// Storage modes.
//
//   memory   — data lives in the process (default; great for local testing).
//   dynamodb — every request loads the household from DynamoDB, runs the same
//              store logic, then saves any new records. Stateless, so it works
//              on AWS Lambda where each request may hit a fresh container.

import { loadState, resetStore, seedDemoData, takeChanges, type Change, type CareEvent, type Note, type Pet, type VetVisit } from "./store.js";

export interface HouseholdState {
  pets: Pet[];
  events: CareEvent[];
  notes: Note[];
  visits: VetVisit[];
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
  if (seed) seedDemoData();
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
  return memoryStorage(seed);
}
