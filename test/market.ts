// The care network's logic (no server, no network): post a request, find and take jobs.
//   npm run test:market
import assert from "node:assert/strict";
import { localParts } from "../src/clock.js";
import { HOME, milesBetween, parseLocation, withDeviceLocation } from "../src/location.js";
import { acceptCareRequest, careRequestStatus, findCareRequests, householdRequests, postCareRequest, seedMarket } from "../src/market.js";
import { notifyOwner, type OwnerMessage } from "../src/notify.js";
import { isCareAlert, logCare, marketRecords, seedDemoData, todayAlerts } from "../src/store.js";

const today = localParts(new Date()).date;
const day = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A pet sitter's phone in Kerrytown, about 0.4 miles from the household. */
const kerrytown = parseLocation("42.2860,-83.7470", encodeURIComponent("Kerrytown"))!;
const asSam = <T>(fn: () => T) => withDeviceLocation(kerrytown, fn);

seedDemoData();
seedMarket();
assert.equal(marketRecords().requests.length, 6);
console.log("✔ sample data: 6 open requests from other households around Ann Arbor");

// --- Posting -----------------------------------------------------------------
// "We're away this weekend, find someone to walk Biscuit twice a day" → the model fills in what was said.
const draft = postCareRequest({ pets: ["Biscuit"], service: "walk", start_date: day(4), end_date: day(5), by: "Mom" });
assert.equal(draft.status, "needs_confirmation");
assert.deepEqual(draft.request.times, ["08:00", "18:00"], "usual walk times when none were said");
assert.equal(draft.request.payPerVisit, 20);
assert.ok(draft.request.paySuggested);
assert.equal(draft.request.location.source, "home", "no device location: the household's address");
assert.match(draft.message, /^Here's the request: dog walks for Biscuit, .* at 8 AM and 6 PM, \$20 a visit, near Ann Arbor, MI\. \$20 is the typical rate around here\. Shall I post it\?$/);
assert.equal(marketRecords().requests.length, 6, "a draft isn't posted");
console.log("✔ draft:", draft.message);

const posted = postCareRequest({ pets: ["Biscuit"], service: "walk", start_date: day(4), end_date: day(5), by: "Mom", confirm: true });
assert.equal(posted.status, "posted");
assert.equal(posted.request.code, "R-1037");
assert.equal(posted.request.household, "Mochi and Biscuit's home");
assert.match(posted.message, /^Posted as R-1037: /);
console.log("✔ posted:", posted.message);

assert.throws(() => postCareRequest({ pets: ["Mochi"], service: "walk", start_date: day(4) }), /Walks are only for dogs, and Mochi isn't a dog/);
assert.throws(() => postCareRequest({ service: "walk", start_date: day(-1) }), /has already passed/);
assert.throws(() => postCareRequest({ service: "walk", start_date: day(5) }), /already have an open request for dog walks on those days \(R-1037\)/);
assert.throws(() => postCareRequest({ service: "feeding", start_date: day(2), end_date: day(30) }), /up to 14 days/);
console.log("✔ refused: walks for a cat, a past date, a second walk request for the same days, a month-long request");

// Auto-location: drafted on a phone, the request carries the device's area.
const fromPhone = withDeviceLocation(parseLocation("42.2799,-83.7449", "Downtown"), () =>
  postCareRequest({ pets: ["Mochi"], service: "drop_in", start_date: day(4), times: ["12:30"], pay_per_visit: 18 }),
);
assert.deepEqual([fromPhone.request.location.label, fromPhone.request.location.source], ["Downtown", "device"]);
assert.equal(parseLocation("not a place", undefined), undefined);
assert.equal(parseLocation("123,456", undefined), undefined, "latitude out of range");
console.log("✔ auto-location: the draft uses the device's location (Downtown), or the household's address without one");

// --- Finding jobs ---------------------------------------------------------------
// "Dog walking jobs within two miles, at least $20, dogs only."
const jobs = asSam(() => findCareRequests({ max_distance_miles: 2, services: ["walk"], species: ["dogs"], min_pay: 20, sitter: "Sam" }));
assert.deepEqual(jobs.matches.map((m) => m.code), ["R-1037", "R-1031", "R-1033"], "nearest first");
assert.equal(jobs.matches[0].miles, 0.4);
assert.match(jobs.message, /^I found 3 jobs\. R-1037: dog walks for Biscuit, .* 0\.4 miles away in Ann Arbor, MI\./);
assert.match(jobs.message, /4 other open jobs don't fit: 2 too far and 2 for other services\.$/);
console.log("✔ find:", jobs.message);

const cheap = asSam(() => findCareRequests({ max_distance_miles: 3, min_pay: 21 }));
assert.ok(!cheap.matches.some((m) => m.code === "R-1037"), "$20 is under the minimum");
assert.ok(cheap.skipped.pay > 0);
const catsOnly = asSam(() => findCareRequests({ max_distance_miles: 10, species: ["cat"] }));
assert.ok(catsOnly.matches.every((m) => m.pets.every((p) => p.species === "cat")));
const later = asSam(() => findCareRequests({ max_distance_miles: 10, from_date: day(6), to_date: day(7) }));
assert.deepEqual(later.matches.map((m) => m.code), ["R-1035", "R-1036"], "the overnight stay and the boarding still run then");
console.log("✔ filters: minimum pay, kinds of pets, days");

// --- Taking a job -------------------------------------------------------------
const taken = acceptCareRequest({ code: "r 1037", sitter: "Sam" });
assert.match(taken.message, /^You're booked for R-1037: .*I've let the household know\./);
assert.ok(taken.alert && isCareAlert(taken.alert));
assert.match(taken.alert!.message, /^Sam took your care request R-1037: dog walks for Biscuit, /);
assert.ok(todayAlerts().some(isCareAlert), "shown on the household page");
console.log("✔ taken:", taken.message);

assert.throws(() => acceptCareRequest({ code: "R-1037", sitter: "Alex" }), /Sam already took R-1037/);
assert.throws(() => acceptCareRequest({ code: "R-1037", sitter: "Sam" }), /You already have R-1037/);
assert.throws(() => acceptCareRequest({ code: "R-9999", sitter: "Sam" }), /can't find request R-9999/);
console.log("✔ refused: someone else's job, a job you already have, an unknown code");

// A clash with an existing booking: Max and Ruby's noon walk is fine, but a second job at
// the same times on the same days isn't.
const clash = postCareRequest({ pets: ["Mochi"], service: "feeding", start_date: day(4), end_date: day(4), times: ["08:15"], by: "Dad", confirm: true });
assert.throws(() => acceptCareRequest({ code: clash.request.code, sitter: "Sam" }), /clashes with your booking R-1037/);
const afterBooking = asSam(() => findCareRequests({ max_distance_miles: 2, sitter: "Sam" }));
// Pepper's and Mochi's 8 AM feedings both fall on a day Sam walks Biscuit at 8 AM.
assert.ok(!afterBooking.matches.some((m) => m.code === clash.request.code) && afterBooking.skipped.clash === 2, "clashing jobs aren't offered");
console.log("✔ clashes with Sam's bookings are refused and no longer offered");

// --- Status, and the household page ----------------------------------------------
assert.match(careRequestStatus({}).message, /R-1037: dog walks for Biscuit, .*: taken by Sam\./);
assert.match(careRequestStatus({ sitter: "Sam" }).message, /^You have 1 booking\. R-1037: dog walks for Biscuit/);
assert.deepEqual(householdRequests().map((r) => [r.code, r.state, r.sitter]), [
  ["R-1038", "open", undefined],
  ["R-1037", "taken", "Sam"],
]);
assert.equal(clash.request.code, "R-1038", "the phone draft was never posted");
console.log("✔ status: the household sees who took what; Sam sees their bookings");

// The owner hears about it by email.
const sent: OwnerMessage[] = [];
await notifyOwner([taken.alert!], async (m) => void sent.push(m));
assert.deepEqual(sent.map((m) => m.subject), ["PetCheck: Sam took your care request"]);
console.log("✔ owner email:", sent[0].subject);

// Sam's visits go into the household's log like anyone else's.
const visit = logCare({ pet: "Biscuit", activity: "walk", by: "Sam" });
assert.match(visit.message, /^Got it\. Sam walked Biscuit/);
console.log("✔ Sam logs a visit:", visit.message);

assert.ok(Math.abs(milesBetween(HOME, kerrytown) - 0.4) < 0.05);
console.log("\nAll care network checks passed.");
