// The backup rules engine's understanding of everyday phrases (no AWS, no server).
//   npm run test:rules
import assert from "node:assert/strict";
import { parseIntent, dateTimeOf, type Intent } from "../src/rules.js";

const ctx = { speaker: "Dad", today: "2026-10-01" }; // a Thursday
const tool = (i: Intent) => (i.kind === "tool" ? `${i.name} ${JSON.stringify(i.input)}` : `say: ${i.text}`);
const check = (text: string, expected: RegExp, extra: Partial<typeof ctx & { previousReply: string }> = {}) => {
  const got = tool(parseIntent(text, { ...ctx, ...extra }));
  assert.match(got, expected, `“${text}” → ${got}`);
  console.log(`✔ “${text}” → ${got}`);
};

check("I fed Mochi", /^log_care .*"pet":"Mochi".*"activity":"feed".*"by":"Dad"/);
check("I just fed mochi", /^log_care .*"pet":"Mochi".*"activity":"feed"/);
check("Walked Biscuit", /^log_care .*"pet":"Biscuit".*"activity":"walk"/);
check("Gave Biscuit his joint supplement", /^log_care .*"pet":"Biscuit".*"activity":"meds"/);
check("Cleaned Mochi's litter box", /^log_care .*"pet":"Mochi".*"activity":"litter"/);
check("Has anyone walked Biscuit?", /^get_status .*"pet":"Biscuit"/);
check("Has anyone fed the cat", /^get_status \{"pet":"cat"\}$/);
check("I walked the dog", /^log_care .*"pet":"dog".*"activity":"walk"/);
check("What's left for Mochi today?", /^get_status .*"pet":"Mochi"/);
check("How's Mochi doing this week?", /^weekly_summary .*"pet":"Mochi"/);
check("Mochi threw up this morning", /^add_note .*"pet":"Mochi".*"text":"Mochi threw up this morning"/);
check("Book Mochi's checkup next Tuesday at 10", /^add_vet_visit .*"pet":"Mochi".*"date":"2026-10-06".*"time":"10:00".*"reason":"checkup"/);
check("Vet appointment for Biscuit tomorrow at 3:30 pm", /^add_vet_visit .*"pet":"Biscuit".*"date":"2026-10-02".*"time":"15:30"/);
check("Vet for Mochi", /^say: What day is the vet visit/);
check("Can dogs eat grapes?", /^say: I can't give veterinary advice/);
check("yes", /^log_care .*"pet":"Mochi".*"activity":"feed".*"confirm":true/, {
  previousReply: "Dad already fed Mochi at 7:52 AM, 10 minutes ago. Do you want me to log it again?",
});
check("no thanks", /^say: Okay, I won't log it again/, {
  previousReply: "Emma already fed Mochi at 7:52 AM, just a minute ago. Do you want me to log it again?",
});
check("hello", /^say: Hi Dad/);
check("blah blah", /^say: Sorry, I didn't catch that/);

assert.deepEqual(dateTimeOf("October 6 at 10am", "2026-10-01"), { date: "2026-10-06", time: "10:00" });
assert.deepEqual(dateTimeOf("on 1/5", "2026-10-01"), { date: "2027-01-05", time: undefined });
console.log("✔ date parsing: “October 6 at 10am”, “1/5” (rolls to next year)");

console.log("\nAll rules checks passed.");
