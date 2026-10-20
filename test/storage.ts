// Tests the persistent storage flow with a fake in-memory backend (no AWS needed).
// Simulates Lambda: every request may land on a fresh container with empty memory.
//   npm run test:storage
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addRecord, emptyState, fileBackend, persistentStorage, type Backend, type HouseholdState } from "../src/storage.js";
import { getStatus, logCare, resetStore, weeklySummary, type Change } from "../src/store.js";
import { acceptCareRequest, careRequestStatus, findCareRequests, postCareRequest } from "../src/market.js";

// A fake "table": just the list of every record ever saved.
const table: Change[] = [];
let writes = 0;
const fake: Backend = {
  async loadAll(): Promise<HouseholdState> {
    const s = emptyState();
    for (const c of table) addRecord(s, c.kind, JSON.parse(JSON.stringify(c.item)));
    return s;
  },
  async saveChanges(changes) {
    writes++;
    table.push(...changes);
  },
};

const coldStart = () => {
  resetStore(); // wipe process memory, like a new Lambda container
  return persistentStorage(fake, "fake");
};

// Request 1: empty table -> demo data is seeded and saved, then Dad logs a feeding.
const r1 = await coldStart().run(() => logCare({ pet: "Mochi", activity: "feed", by: "Dad" }));
assert.equal(r1.status, "logged");
assert.ok(table.some((c) => c.kind === "pet"), "demo pets were saved");
console.log("✔ cold start seeded demo data, then:", r1.message);

// Request 2 on a *different* container: the duplicate check still sees Dad's feeding.
const r2 = await coldStart().run(() => logCare({ pet: "Mochi", activity: "feed", by: "Emma" }));
assert.equal(r2.status, "needs_confirmation");
console.log("✔ duplicate caught across containers:", r2.message);

// Request 3: read-only calls save nothing.
const before = writes;
const status = await coldStart().run(() => getStatus({ pet: "Mochi" }));
assert.equal(writes, before, "read-only call should not write");
assert.match(status.message, /Dad/);
console.log("✔ read-only call, no writes:", status.message);

// Request 4: weekly summary includes the seeded history.
const week = await coldStart().run(() => weeklySummary({ pet: "Mochi" }));
assert.match(week.message, /ate less than usual/);
console.log("✔ history persisted:", week.message);

// Concurrent requests in one container are serialized, not interleaved.
const s = coldStart();
const [a, b] = await Promise.all([
  s.run(() => logCare({ pet: "Biscuit", activity: "walk", by: "Dad" })),
  s.run(() => logCare({ pet: "Biscuit", activity: "walk", by: "Emma" })),
]);
assert.equal(a.status, "logged");
assert.equal(b.status, "needs_confirmation");
console.log("✔ concurrent requests serialized correctly");

// The care network persists like everything else: a request posted on one container is
// found and taken on another, and the household sees who took it on a third.
assert.ok(table.some((c) => c.kind === "request"), "sample care requests were saved with the demo data");
const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const posted = await coldStart().run(() => postCareRequest({ service: "walk", start_date: nextWeek, by: "Mom", confirm: true }));
const found = await coldStart().run(() => findCareRequests({ services: ["walk"], from_date: nextWeek, to_date: nextWeek, sitter: "Sam" }));
assert.ok(found.matches.some((m) => m.code === posted.request.code), found.message);
await coldStart().run(() => acceptCareRequest({ code: posted.request.code, sitter: "Sam" }));
const status2 = await coldStart().run(() => careRequestStatus({}));
assert.match(status2.message, new RegExp(`${posted.request.code}.*taken by Sam`));
console.log("✔ care request posted, found and taken across containers:", status2.message);

// STORAGE=file: records are appended to a JSON Lines file and survive a restart.
const dir = await mkdtemp(join(tmpdir(), "petcheck-"));
const file = join(dir, "data.jsonl");
try {
  resetStore();
  await persistentStorage(fileBackend(file), "file").run(() => logCare({ pet: "Mochi", activity: "feed", by: "Dad" }));
  resetStore(); // "restart"
  const again = await persistentStorage(fileBackend(file), "file").run(() => logCare({ pet: "Mochi", activity: "feed", by: "Emma" }));
  assert.equal(again.status, "needs_confirmation", "Dad's feeding was read back from the file");
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  assert.ok(lines.every((l) => JSON.parse(l).kind), "one JSON record per line");
  console.log(`✔ STORAGE=file: ${lines.length} records in ${file.split("/").pop()}, read back after a restart`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("\nAll storage checks passed.");
