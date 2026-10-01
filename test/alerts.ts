// Missed-task alert logic, using the demo clock (no AWS needed).
//   npm run test:alerts
import assert from "node:assert/strict";
import { localParts, localToDate, setDemoOffset } from "../src/clock.js";
import { checkMissedTasks, getStatus, logCare, seedDemoData, todayAlerts, type Alert } from "../src/store.js";

const today = localParts(new Date()).date;
const at = (hhmm: string) => setDemoOffset(localToDate(today, hhmm).getTime() - Date.now());
const show = (label: string, alerts: Alert[]) =>
  console.log(`✔ ${label}: ${alerts.length ? alerts.map((a) => `[${a.level}] ${a.message}`).join("\n    ") : "(no new alerts)"}`);

seedDemoData(); // today starts empty: nothing logged yet

at("18:20");
let a = checkMissedTasks();
assert.ok(!a.some((x) => x.pet === "Mochi" && x.label === "dinner"), "Mochi's dinner is only 20 min late");
assert.ok(a.some((x) => x.pet === "Biscuit" && x.label === "dinner" && x.level === "household"));
assert.ok(!a.some((x) => x.label === "breakfast"), "morning tasks are >3h late and skipped");
show("6:20 PM", a);

at("18:30");
a = checkMissedTasks();
assert.deepEqual(a.map((x) => `${x.pet}/${x.label}/${x.level}`).sort(), ["Biscuit/dinner/owner", "Mochi/dinner/household"]);
show("6:30 PM", a);

a = checkMissedTasks();
assert.equal(a.length, 0, "running again raises nothing new");
show("6:30 PM again", a);

at("19:00");
a = checkMissedTasks();
assert.ok(a.some((x) => x.pet === "Mochi" && x.label === "dinner" && x.level === "owner"));
assert.ok(!a.some((x) => x.pet === "Biscuit" && x.label === "dinner"), "Biscuit's dinner already escalated at 6:30");
show("7:00 PM", a);

at("19:05");
logCare({ pet: "Mochi", activity: "feed", by: "Emma" });
const mochiDinner = todayAlerts().filter((x) => x.pet === "Mochi" && x.label === "dinner");
assert.ok(mochiDinner.length === 2 && mochiDinner.every((x) => x.resolved), "logging dinner resolves its alerts");
console.log("✔ 7:05 PM: Emma logs Mochi's dinner → its alerts show as resolved");

at("19:40");
a = checkMissedTasks();
assert.ok(!a.some((x) => x.pet === "Mochi" && x.label === "dinner"), "no alerts for a task that's done");
show("7:40 PM", a);

at("17:00");
assert.equal(todayAlerts().length, 0, "alerts raised later in the day are hidden at 5 PM");
console.log("✔ 5:00 PM view: alerts from later (simulated) times are hidden");

// Slot matching: a mid-afternoon feeding with breakfast missed is a late breakfast, not dinner.
seedDemoData();
at("14:48");
logCare({ pet: "Mochi", activity: "feed", by: "Dad" });
let slots = getStatus({ pet: "Mochi" }).pets[0].slots;
assert.equal(slots.find((x) => x.label === "breakfast")!.state, "done");
assert.notEqual(slots.find((x) => x.label === "dinner")!.state, "done");
console.log("✔ 2:48 PM feeding with breakfast missed → counts as breakfast");
at("17:30");
logCare({ pet: "Mochi", activity: "feed", by: "Emma" });
slots = getStatus({ pet: "Mochi" }).pets[0].slots;
assert.equal(slots.find((x) => x.label === "dinner")!.state, "done");
console.log("✔ 5:30 PM feeding → counts as the 6 PM dinner (within an hour early)");

setDemoOffset(0);
console.log("\nAll alert checks passed.");
