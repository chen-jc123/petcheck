// Tests the persistent storage flow with a fake in-memory backend (no AWS needed).
// Simulates Lambda: every request may land on a fresh container with empty memory.
//   npm run test:storage
import assert from "node:assert/strict";
import { persistentStorage, type Backend, type HouseholdState } from "../src/storage.js";
import { getStatus, logCare, resetStore, weeklySummary, type Change } from "../src/store.js";

// A fake "table": just the list of every record ever saved.
const table: Change[] = [];
let writes = 0;
const fake: Backend = {
  async loadAll(): Promise<HouseholdState> {
    const s: HouseholdState = { pets: [], events: [], notes: [], visits: [] };
    for (const c of table) {
      const copy = JSON.parse(JSON.stringify(c.item));
      if (c.kind === "pet") s.pets.push(copy);
      if (c.kind === "event") s.events.push(copy);
      if (c.kind === "note") s.notes.push(copy);
      if (c.kind === "visit") s.visits.push(copy);
    }
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

console.log("\nAll storage checks passed.");
