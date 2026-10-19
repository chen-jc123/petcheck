// Missed-task alert logic, using the demo clock (no AWS needed).
//   npm run test:alerts
import assert from "node:assert/strict";
import { localParts, localToDate, setDemoOffset } from "../src/clock.js";
import { addVetVisit, checkMissedTasks, getStatus, isVetReminder, logCare, seedDemoData, todayAlerts, type Alert } from "../src/store.js";
import { notifyOwner, type OwnerMessage } from "../src/notify.js";
import { runMissedCheck, startMissedCheckSchedule } from "../src/api.js";

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

// Vet visits: announced once, the day before, from 9 AM.
seedDemoData();
const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
at("08:00");
addVetVisit({ pet: "Mochi", date: tomorrow, time: "10:00", reason: "checkup" });
addVetVisit({ pet: "Biscuit", date: today, time: "16:00" });
assert.equal(checkMissedTasks().filter(isVetReminder).length, 0, "not before 9 AM");
at("09:05");
a = checkMissedTasks().filter(isVetReminder);
assert.deepEqual(a.map((x) => `${x.level}: ${x.message}`), ["household: Reminder: Mochi has a vet visit tomorrow at 10 AM for checkup."]);
show("9:05 AM, visit tomorrow", a);
at("09:10");
assert.equal(checkMissedTasks().filter(isVetReminder).length, 0, "raised once; today's visit gets no day-before reminder");
assert.ok(todayAlerts().some((x) => isVetReminder(x) && !x.resolved), "shown on the household page");
console.log("✔ 9:10 AM: not raised again, still shown on the household page");

// Owner messages (SNS email on AWS): owner-level alerts and vet reminders only.
const vetReminder = todayAlerts().find(isVetReminder)!;
seedDemoData();
at("19:00");
const evening = checkMissedTasks();
const sent: OwnerMessage[] = [];
const n = await notifyOwner([...evening, vetReminder], async (m) => void sent.push(m));
assert.equal(n, evening.filter((x) => x.level === "owner").length + 1);
assert.ok(sent.every((m) => !/^Reminder/.test(m.message)), "household reminders are not emailed");
assert.ok(sent.some((m) => m.subject === "PetCheck: Mochi's vet visit is tomorrow"));
assert.ok(sent.some((m) => /^PetCheck: Biscuit missed dinner$/.test(m.subject) && /tell Alexa/.test(m.message)));
console.log(`✔ owner emails: ${sent.map((m) => m.subject).join(" · ")}`);

// The schedule runs the real check on its own (EventBridge on AWS, a timer locally): no button.
seedDemoData();
const stop = startMissedCheckSchedule(20, () => runMissedCheck("18:30"));
await new Promise((r) => setTimeout(r, 150));
stop();
at("18:35");
const auto = todayAlerts();
assert.deepEqual(
  auto.map((x) => `${x.pet}/${x.label}/${x.level}`).sort(),
  ["Biscuit/dinner/household", "Biscuit/dinner/owner", "Mochi/dinner/household"],
  "every scheduled run is safe to repeat: each alert exists once",
);
console.log(`✔ scheduled check (every 20 ms, ~7 runs): ${auto.length} alerts, each raised once`);

setDemoOffset(0);
console.log("\nAll alert checks passed.");
