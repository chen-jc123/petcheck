// Quick logic check with no server or network: `npm run smoke`
import assert from "node:assert/strict";
import { setDemoOffset, lastNLocalDates } from "../src/clock.js";
import {
  seedDemoData,
  logCare,
  getStatus,
  addNote,
  addVetVisit,
  weeklySummary,
  overdueTasks,
} from "../src/store.js";

seedDemoData();

// 1. Log a feeding, then a duplicate by someone else -> needs confirmation.
const first = logCare({ pet: "Mochi", activity: "feed", by: "Dad" });
assert.equal(first.status, "logged");
console.log("✔", first.message);

const dup = logCare({ pet: "mochi", activity: "feed", by: "Emma" });
assert.equal(dup.status, "needs_confirmation");
console.log("✔", dup.message);

const confirmed = logCare({ pet: "Mochi", activity: "feed", by: "Emma", confirm: true });
assert.equal(confirmed.status, "logged");
console.log("✔ confirmed duplicate logged");

// 2. Status reads naturally.
console.log("✔", getStatus({ pet: "Biscuit" }).message);

// 3. Notes are counted, never interpreted.
addNote({ pet: "Mochi", text: "threw up after breakfast", by: "Mom" });
const n2 = addNote({ pet: "Mochi", text: "threw up again", by: "Mom" });
assert.match(n2.message, /3 notes/); // includes the seeded note
console.log("✔", n2.message);

// 4. Vet visit (a week from today); dates already past are refused.
const today = lastNLocalDates(1)[0];
const nextWeek = new Date(Date.parse(`${today}T12:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
const visit = addVetVisit({ pet: "Mochi", date: nextWeek, time: "10:00", reason: "annual checkup" });
assert.match(visit.message, /remind the household the day before/);
console.log("✔", visit.message);
assert.throws(() => addVetVisit({ pet: "Mochi", date: "2020-01-01" }), /already passed/);
console.log("✔ a vet visit in the past is refused");

// 5. Weekly summary (seed data includes a realistic past week).
console.log("✔", weeklySummary({ pet: "Mochi" }).message);

// 6. Unknown pet gives a friendly error.
assert.throws(() => logCare({ pet: "Rex", activity: "walk" }), /don't know a pet called Rex/);
console.log("✔ unknown pet handled");

// 7. Demo clock: jump ahead 12 hours and see what is overdue.
setDemoOffset(12 * 3_600_000);
console.log("✔ overdue after +12h:", JSON.stringify(overdueTasks()));
setDemoOffset(0);

console.log("\nAll smoke checks passed.");
