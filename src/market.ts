// The PetCheck care network: when nobody at home can do it, a household asks Alexa for help
// ("we're away this weekend, find someone to walk Biscuit twice a day"), and pet sitters
// nearby ask Alexa for jobs that fit them. The assistant turns what was said into a
// fixed-format request; the device location fills in where. Once a sitter takes a
// request, their visits are logged in the household's PetCheck like anyone else's, so the
// owner sees them and a missed visit raises the usual alerts.
//
// Records are only ever added (like the rest of PetCheck): a request never changes, and a
// sitter taking it is a separate claim; the first claim wins. Pure logic, like store.ts.

import { hhmmToMinutes, localParts, minutesToSpoken, now, spokenDate } from "./clock.js";
import { deviceLocation, milesBetween, type Place } from "./location.js";
import { PetCheckError, findPet, insert, joinNames, listPets, marketRecords, newId, personName, type Alert, type Pet } from "./store.js";

export const SERVICES = ["walk", "drop_in", "feeding", "overnight", "boarding", "grooming"] as const;
export type Service = (typeof SERVICES)[number];

const SERVICE_NAME: Record<Service, string> = {
  walk: "dog walks",
  drop_in: "drop-in visits",
  feeding: "feeding visits",
  overnight: "overnight stays",
  boarding: "boarding",
  grooming: "grooming",
};
/** Used when the request doesn't say when. */
const DEFAULT_TIMES: Record<Service, string[]> = {
  walk: ["08:00", "18:00"],
  drop_in: ["12:00"],
  feeding: ["08:00", "18:00"],
  overnight: ["19:00"],
  boarding: ["09:00"],
  grooming: ["10:00"],
};
/** Typical local rate per visit (per night for overnight stays and boarding), suggested when none is given. */
const TYPICAL_PAY: Record<Service, number> = { walk: 20, drop_in: 18, feeding: 15, overnight: 60, boarding: 45, grooming: 40 };
const MAX_DAYS = 14;
/** Two bookings closer together than this on the same day clash. */
const CLASH_MIN = 60;

export const HOUSEHOLD_ID = process.env.HOUSEHOLD_ID ?? "demo";

export interface CareRequest {
  id: string;
  /** Short id that's easy to say, e.g. "R-1037". */
  code: string;
  householdId: string;
  /** How sitters see the household, e.g. "Mochi and Biscuit's home". */
  household: string;
  pets: { name: string; species: string }[];
  service: Service;
  startDate: string; // YYYY-MM-DD, household local
  endDate: string;
  times: string[]; // HH:MM, every day of the request
  payPerVisit: number; // USD, per night for overnight stays and boarding
  paySuggested: boolean;
  /** The area. Sitters see its name and distance; the exact address goes only to whoever takes the job. */
  location: Place;
  notes?: string;
  postedBy: string;
  postedAt: string; // UTC ISO
}

export interface Claim {
  id: string;
  requestId: string;
  sitter: string;
  at: string; // UTC ISO
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const today = () => localParts(now()).date;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/** The claim that holds a request: the first one, if two sitters took it at once. */
function claimOf(r: CareRequest): Claim | undefined {
  return marketRecords()
    .claims.filter((c) => c.requestId === r.id)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
}

export function requestState(r: CareRequest): "open" | "taken" | "past" {
  if (claimOf(r)) return "taken";
  return r.endDate < today() ? "past" : "open";
}

/** Requests a sitter has taken. */
export function bookings(sitter: string): CareRequest[] {
  return marketRecords().requests.filter((r) => claimOf(r)?.sitter === sitter);
}

/** Same days, and visit times less than CLASH_MIN apart. */
function clashes(a: CareRequest, b: CareRequest): boolean {
  if (a.endDate < b.startDate || b.endDate < a.startDate) return false;
  return a.times.some((t) => b.times.some((u) => Math.abs(hhmmToMinutes(t) - hhmmToMinutes(u)) < CLASH_MIN));
}

function nextCode(): string {
  const used = marketRecords().requests.map((r) => Number(r.code.replace(/\D/g, "")) || 0);
  return `R-${Math.max(1030, ...used) + 1}`;
}

function datesText(r: CareRequest): string {
  return r.startDate === r.endDate ? spokenDate(r.startDate) : `${spokenDate(r.startDate)} to ${spokenDate(r.endDate)}`;
}

const timesText = (times: string[]) => `at ${joinNames(times.map((t) => minutesToSpoken(hhmmToMinutes(t))))}`;
const payText = (r: CareRequest) => `$${r.payPerVisit} a ${r.service === "overnight" || r.service === "boarding" ? "night" : "visit"}`;
const milesText = (miles: number) => (miles < 0.1 ? "under 0.1 miles away" : `${miles.toFixed(1)} miles away`);

/** "dog walks for Biscuit, Saturday, October 24 to Sunday, October 25, at 8 AM and 6 PM, $20 a visit, near Ann Arbor, MI" */
export function describe(r: CareRequest, miles?: number): string {
  const what = `${SERVICE_NAME[r.service]} for ${joinNames(r.pets.map((p) => p.name))}`;
  const where = miles === undefined ? `near ${r.location.label}` : `${milesText(miles)} in ${r.location.label}`;
  return `${what}, ${datesText(r)}, ${timesText(r.times)}, ${payText(r)}, ${where}`;
}

function normalizeTime(t: string): string {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new PetCheckError(`Time "${t}" should look like 08:00 or 18:30.`);
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// ---------------------------------------------------------------------------
// Households: post a request
// ---------------------------------------------------------------------------

export interface PostInput {
  pets?: string[];
  service: Service;
  start_date: string;
  end_date?: string;
  times?: string[];
  pay_per_visit?: number;
  notes?: string;
  by?: string;
  confirm?: boolean;
}

/**
 * Turn what was said into a fixed-format request. Without confirm it returns the draft to
 * read back ("needs_confirmation"); with confirm=true it posts it.
 */
export function postCareRequest(input: PostInput): { status: "needs_confirmation" | "posted"; request: CareRequest; message: string } {
  const service = input.service;
  if (!(SERVICES as readonly string[]).includes(service)) throw new PetCheckError(`Service should be one of ${SERVICES.join(", ")}.`);

  // Pets: the ones named, or every pet the service fits.
  let pets: Pet[] = input.pets?.length
    ? input.pets.map((name) => findPet(name))
    : listPets().filter((p) => service !== "walk" || p.species === "dog");
  pets = pets.filter((p, i) => pets.findIndex((q) => q.id === p.id) === i);
  if (!pets.length) throw new PetCheckError("Which pets is this request for?");
  const notDogs = service === "walk" ? pets.filter((p) => p.species !== "dog") : [];
  if (notDogs.length) {
    const names = joinNames(notDogs.map((p) => p.name));
    throw new PetCheckError(`Walks are only for dogs, and ${names} ${notDogs.length > 1 ? "aren't dogs" : "isn't a dog"}. Post a separate drop-in or feeding request for ${names}.`);
  }

  // When.
  const start = input.start_date;
  const end = input.end_date ?? start;
  if (!isDate(start) || !isDate(end)) throw new PetCheckError("Dates should look like 2026-10-24.");
  if (start < today()) throw new PetCheckError(`${spokenDate(start)} has already passed. Which days do you need help?`);
  if (end < start) throw new PetCheckError("The last day is before the first day.");
  if (dayCount(start, end) > MAX_DAYS) throw new PetCheckError(`Requests can cover up to ${MAX_DAYS} days.`);
  const times = [...new Set((input.times?.length ? input.times : DEFAULT_TIMES[service]).map(normalizeTime))].sort();
  if (times.length > 4) throw new PetCheckError("Up to 4 visits a day, please.");

  // Pay.
  const pay = Math.round((input.pay_per_visit ?? TYPICAL_PAY[service]) * 100) / 100;
  if (!(pay >= 1 && pay <= 500)) throw new PetCheckError("Pay should be between $1 and $500 a visit.");

  const clash = marketRecords().requests.find(
    (r) => r.householdId === HOUSEHOLD_ID && r.service === service && requestState(r) === "open" && r.startDate <= end && start <= r.endDate,
  );
  if (clash) {
    throw new PetCheckError(`You already have an open request for ${SERVICE_NAME[service]} on those days (${clash.code}), and nobody has taken it yet.`);
  }

  const request: CareRequest = {
    id: newId("req"),
    code: nextCode(),
    householdId: HOUSEHOLD_ID,
    household: `${joinNames(listPets().map((p) => p.name))}'s home`,
    pets: pets.map((p) => ({ name: p.name, species: p.species })),
    service,
    startDate: start,
    endDate: end,
    times,
    payPerVisit: pay,
    paySuggested: input.pay_per_visit === undefined,
    location: { ...deviceLocation() },
    notes: input.notes?.trim().slice(0, 200) || undefined,
    postedBy: personName(input.by),
    postedAt: now().toISOString(),
  };
  const summary = describe(request);
  if (!input.confirm) {
    const rate = request.paySuggested ? ` $${pay} is the typical rate around here.` : "";
    return { status: "needs_confirmation", request, message: `Here's the request: ${summary}.${rate} Shall I post it?` };
  }
  insert("request", request);
  return {
    status: "posted",
    request,
    message: `Posted as ${request.code}: ${summary}. Sitters nearby can see it now, and I'll let you know when someone takes it.`,
  };
}

// ---------------------------------------------------------------------------
// Sitters: find and take jobs
// ---------------------------------------------------------------------------

export interface FindInput {
  max_distance_miles?: number;
  services?: Service[];
  species?: string[];
  from_date?: string;
  to_date?: string;
  min_pay?: number;
  sitter?: string;
  limit?: number;
}

/** Open requests that fit everything the sitter asked for, nearest first. */
export function findCareRequests(input: FindInput) {
  const here = deviceLocation();
  const maxMiles = input.max_distance_miles ?? 5;
  const species = input.species?.map((s) => s.toLowerCase().replace(/s$/, ""));
  const from = input.from_date && isDate(input.from_date) ? input.from_date : today();
  const to = input.to_date && isDate(input.to_date) ? input.to_date : undefined;
  const mine = input.sitter ? bookings(personName(input.sitter)) : [];
  const skipped = { far: 0, service: 0, pets: 0, days: 0, pay: 0, clash: 0 };
  const matches: { r: CareRequest; miles: number }[] = [];
  for (const r of marketRecords().requests) {
    if (requestState(r) !== "open") continue;
    const miles = milesBetween(here, r.location);
    if (miles > maxMiles) skipped.far++;
    else if (input.services?.length && !input.services.includes(r.service)) skipped.service++;
    else if (species?.length && r.pets.some((p) => !species.includes(p.species))) skipped.pets++;
    else if (r.endDate < from || (to && r.startDate > to)) skipped.days++;
    else if (input.min_pay !== undefined && r.payPerVisit < input.min_pay) skipped.pay++;
    else if (mine.some((b) => clashes(b, r))) skipped.clash++;
    else matches.push({ r, miles });
  }
  matches.sort((a, b) => a.miles - b.miles || b.r.payPerVisit - a.r.payPerVisit);
  const top = matches.slice(0, Math.min(Math.max(input.limit ?? 3, 1), 10));

  const why = [
    skipped.far && `${skipped.far} too far`,
    skipped.service && `${skipped.service} for other services`,
    skipped.pets && `${skipped.pets} with other kinds of pets`,
    skipped.days && `${skipped.days} on other days`,
    skipped.pay && `${skipped.pay} paying under $${input.min_pay}`,
    skipped.clash && `${skipped.clash} clashing with your bookings`,
  ].filter(Boolean) as string[];
  const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
  const others = skippedTotal ? ` ${skippedTotal} other open ${skippedTotal === 1 ? "job doesn't" : "jobs don't"} fit: ${joinNames(why)}.` : "";
  const message = top.length
    ? `I found ${matches.length} ${matches.length === 1 ? "job" : "jobs"}` +
      (matches.length > top.length ? `; the closest ${top.length}` : "") +
      `. ${top.map((m) => `${m.r.code}: ${describe(m.r, m.miles)}.`).join(" ")}${others}`
    : `I didn't find any open jobs that fit.${others}`;
  return {
    message,
    searchedFrom: here.label,
    matches: top.map(({ r, miles }) => ({
      code: r.code,
      service: r.service,
      pets: r.pets,
      startDate: r.startDate,
      endDate: r.endDate,
      times: r.times,
      payPerVisit: r.payPerVisit,
      miles: Math.round(miles * 10) / 10,
      area: r.location.label,
      household: r.household,
    })),
    skipped,
  };
}

/** A sitter takes a request; the household hears about it (the returned alert, for the owner's email). */
export function acceptCareRequest(input: { code: string; sitter?: string }): { request: CareRequest; claim: Claim; alert?: Alert; message: string } {
  const digits = input.code.match(/\d{3,6}/)?.[0];
  const r = digits ? marketRecords().requests.find((x) => x.code === `R-${digits}`) : undefined;
  if (!r) throw new PetCheckError(`I can't find request ${input.code}. Ask me to find jobs again for the current list.`);
  const sitter = personName(input.sitter);
  const holder = claimOf(r);
  if (holder) throw new PetCheckError(holder.sitter === sitter ? `You already have ${r.code}.` : `Sorry, ${holder.sitter} already took ${r.code}.`);
  if (requestState(r) === "past") throw new PetCheckError(`${r.code} has already ended.`);
  const clash = bookings(sitter).find((b) => clashes(b, r));
  if (clash) throw new PetCheckError(`${r.code} clashes with your booking ${clash.code}: ${describe(clash)}.`);

  const claim: Claim = { id: newId("claim"), requestId: r.id, sitter, at: now().toISOString() };
  insert("claim", claim);
  const pets = joinNames(r.pets.map((p) => p.name));
  let alert: Alert | undefined;
  if (r.householdId === HOUSEHOLD_ID) {
    alert = {
      id: newId("alert"),
      petId: findPet(r.pets[0].name).id,
      pet: pets,
      level: "household",
      date: today(),
      slot: `request@${r.id}`,
      label: "care request",
      time: r.times[0],
      at: claim.at,
      message: `${sitter} took your care request ${r.code}: ${SERVICE_NAME[r.service]} for ${pets}, ${datesText(r)}.`,
    };
    insert("alert", alert);
  }
  return {
    request: r,
    claim,
    alert,
    message: `You're booked for ${r.code}: ${describe(r)}. I've let the household know. When you've done a visit, just tell me, like "I walked ${r.pets[0].name}".`,
  };
}

/** A sitter's upcoming bookings, or (without a sitter) this household's requests and who took them. */
export function careRequestStatus(input: { sitter?: string }): { message: string; requests: ReturnType<typeof householdRequests> } {
  if (input.sitter) {
    const sitter = personName(input.sitter);
    const upcoming = bookings(sitter).filter((r) => r.endDate >= today());
    return {
      message: upcoming.length
        ? `You have ${upcoming.length} ${upcoming.length === 1 ? "booking" : "bookings"}. ${upcoming.map((r) => `${r.code}: ${describe(r)}.`).join(" ")}`
        : "You have no bookings yet. Ask me to find jobs near you.",
      requests: upcoming.map(view),
    };
  }
  const mine = householdRequests().filter((r) => r.state !== "past");
  return {
    message: mine.length
      ? mine.map((r) => `${r.code}: ${SERVICE_NAME[r.service]} for ${joinNames(r.pets.map((p) => p.name))}, ${r.dates}: ${r.state === "taken" ? `taken by ${r.sitter}` : "not taken yet"}.`).join(" ")
      : "You haven't posted any care requests. Tell me when you need someone to look after your pets.",
    requests: mine,
  };
}

function view(r: CareRequest) {
  const claim = claimOf(r);
  return { ...r, state: requestState(r), sitter: claim?.sitter, takenAt: claim?.at, dates: datesText(r), summary: describe(r) };
}

/** This household's requests for the household page, newest first (ended ones for a week). */
export function householdRequests() {
  const weekAgo = addDays(today(), -7);
  return marketRecords()
    .requests.filter((r) => r.householdId === HOUSEHOLD_ID && r.endDate >= weekAgo)
    .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
    .map(view);
}

// ---------------------------------------------------------------------------
// Sample data: other households' open requests around Ann Arbor, dated from today
// ---------------------------------------------------------------------------

const SAMPLE: {
  pets: { name: string; species: string }[];
  service: Service;
  days: [number, number];
  times: string[];
  pay: number;
  at: [number, number, string];
  by: string;
}[] = [
  { pets: [{ name: "Luna", species: "dog" }], service: "walk", days: [2, 3], times: ["07:30", "17:30"], pay: 22, at: [42.2869, -83.7372, "Water Hill"], by: "Priya" },
  { pets: [{ name: "Pepper", species: "cat" }], service: "feeding", days: [1, 4], times: ["08:00", "19:00"], pay: 16, at: [42.2701, -83.7303, "Burns Park"], by: "Tom" },
  { pets: [{ name: "Max", species: "dog" }, { name: "Ruby", species: "dog" }], service: "walk", days: [3, 3], times: ["12:00"], pay: 25, at: [42.2615, -83.7455, "Allmendinger"], by: "Jordan" },
  { pets: [{ name: "Bella", species: "dog" }], service: "drop_in", days: [1, 1], times: ["13:00"], pay: 14, at: [42.2899, -83.7445, "Kerrytown"], by: "Sofia" },
  { pets: [{ name: "Coco", species: "dog" }], service: "overnight", days: [5, 7], times: ["19:00"], pay: 65, at: [42.2411, -83.613, "Ypsilanti"], by: "Marcus" },
  { pets: [{ name: "Milo", species: "cat" }], service: "boarding", days: [2, 6], times: ["09:00"], pay: 40, at: [42.3375, -83.8886, "Dexter"], by: "Hannah" },
];

/** Add the sample requests from other households (call after seedDemoData). */
export function seedMarket(): void {
  const start = today();
  SAMPLE.forEach((s, i) => {
    insert("request", {
      id: newId("req"),
      code: `R-${1031 + i}`,
      householdId: `sample-${i + 1}`,
      household: `${joinNames(s.pets.map((p) => p.name))}'s home`,
      pets: s.pets,
      service: s.service,
      startDate: addDays(start, s.days[0]),
      endDate: addDays(start, s.days[1]),
      times: s.times,
      payPerVisit: s.pay,
      paySuggested: false,
      location: { lat: s.at[0], lng: s.at[1], label: s.at[2], source: "home" },
      postedBy: s.by,
      postedAt: new Date(now().getTime() - (i + 1) * 3_600_000).toISOString(),
    });
  });
}
