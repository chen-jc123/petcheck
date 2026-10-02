// PetCheck core logic. Pure TypeScript with no MCP or AWS imports, so it is
// easy to test and the storage can be swapped for DynamoDB later without
// touching the tool definitions.

import {
  now,
  localParts,
  hhmmToMinutes,
  minutesToSpoken,
  spokenTime,
  lastNLocalDates,
  weekdayName,
  localToDate,
  spokenDate,
} from "./clock.js";

export const ACTIVITIES = ["feed", "walk", "meds", "litter", "water", "groom", "other"] as const;
export type Activity = (typeof ACTIVITIES)[number];

export interface RoutineItem {
  activity: Activity;
  time: string; // "HH:MM", household local time
  label?: string; // e.g. "heartworm pill", "dinner"
}

export interface Pet {
  id: string;
  name: string;
  species: string;
  routine: RoutineItem[];
  createdOn: string; // YYYY-MM-DD household local; summaries ignore days before this
}

export interface CareEvent {
  id: string;
  petId: string;
  activity: Activity;
  by: string;
  at: string; // UTC ISO
  detail?: string;
}

export interface Note {
  id: string;
  petId: string;
  text: string;
  by: string;
  at: string; // UTC ISO
}

export interface VetVisit {
  id: string;
  petId: string;
  date: string; // YYYY-MM-DD, household local
  time?: string; // HH:MM, household local
  reason?: string;
}

/** Same pet + same activity logged again within this window asks for confirmation. */
export const DUPLICATE_WINDOW_MIN = 30;
/** A routine task counts as overdue this long after its scheduled time. */
export const OVERDUE_GRACE_MIN = 30;
/** Missed-task alerts: remind the household at +30 min, escalate to the owner at +60 min. */
export const REMIND_AFTER_MIN = OVERDUE_GRACE_MIN;
export const ESCALATE_AFTER_MIN = 60;
/**
 * Tasks more than this late are skipped. The scheduler runs every 5 minutes, so it
 * has already alerted about them; this also avoids an alert flood after downtime.
 */
export const MAX_ALERT_AGE_MIN = 180;

export type AlertLevel = "household" | "owner";

export interface Alert {
  id: string;
  petId: string;
  pet: string;
  level: AlertLevel;
  date: string; // household-local date of the missed task
  slot: string; // e.g. "dinner@18:00" — identifies the routine task
  label: string;
  time: string; // HH:MM the task was due
  at: string; // UTC ISO when the alert was raised
  message: string;
}

let seq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// In-memory data (replaced by DynamoDB in the next milestone)
// ---------------------------------------------------------------------------

const db = {
  pets: [] as Pet[],
  events: [] as CareEvent[],
  notes: [] as Note[],
  visits: [] as VetVisit[],
  alerts: [] as Alert[],
};

export type Kind = "pet" | "event" | "note" | "visit" | "alert";
export type Change = { kind: Kind; item: Pet | CareEvent | Note | VetVisit | Alert };

/** New records created since the last takeChanges() — what a persistent store must save. */
let changes: Change[] = [];

function insert(kind: "pet", item: Pet): void;
function insert(kind: "event", item: CareEvent): void;
function insert(kind: "note", item: Note): void;
function insert(kind: "visit", item: VetVisit): void;
function insert(kind: "alert", item: Alert): void;
function insert(kind: Kind, item: Pet | CareEvent | Note | VetVisit | Alert): void {
  if (kind === "pet") db.pets.push(item as Pet);
  else if (kind === "event") db.events.push(item as CareEvent);
  else if (kind === "note") db.notes.push(item as Note);
  else if (kind === "alert") db.alerts.push(item as Alert);
  else db.visits.push(item as VetVisit);
  changes.push({ kind, item });
}

/** Return and clear the list of records created since the last call. */
export function takeChanges(): Change[] {
  const out = changes;
  changes = [];
  return out;
}

/** Replace the in-memory data with records loaded from a persistent store. */
export function loadState(state: {
  pets: Pet[];
  events: CareEvent[];
  notes: Note[];
  visits: VetVisit[];
  alerts?: Alert[];
}): void {
  db.pets = [...state.pets];
  db.events = [...state.events];
  db.notes = [...state.notes];
  db.visits = [...state.visits];
  db.alerts = [...(state.alerts ?? [])];
  changes = [];
}

export function resetStore(): void {
  changes = [];
  db.pets = [];
  db.events = [];
  db.notes = [];
  db.visits = [];
  db.alerts = [];
}

export function seedDemoData(): void {
  resetStore();
  const created = lastNLocalDates(8)[0];
  addPet({
    createdOn: created,
    name: "Mochi",
    species: "cat",
    routine: [
      { activity: "feed", time: "08:00", label: "breakfast" },
      { activity: "feed", time: "18:00", label: "dinner" },
      { activity: "litter", time: "20:00" },
    ],
  });
  addPet({
    createdOn: created,
    name: "Biscuit",
    species: "dog",
    routine: [
      { activity: "feed", time: "07:30", label: "breakfast" },
      { activity: "walk", time: "07:45", label: "morning walk" },
      { activity: "feed", time: "17:30", label: "dinner" },
      { activity: "walk", time: "19:00", label: "evening walk" },
      { activity: "meds", time: "09:00", label: "joint supplement" },
    ],
  });
  seedHistory();
}

/**
 * A believable previous week so weekly_summary sounds real in the demo.
 * Today is left empty so the live demo starts clean.
 * Mochi: dinner missed 3 days ago, litter skipped 5 days ago, one note 2 days ago.
 */
/**
 * Demo video setup: mark every routine task due before now as done (by realistic
 * family members), so the household page starts tidy at any time of day. Both
 * dinners always stay open: Dad's "I fed Mochi" becomes Mochi's dinner, and
 * Biscuit's dinner is the task nobody did for the 7 PM missed-task scene.
 */
export function seedTodaySoFar(keepOpen = (_pet: string, label: string) => label === "dinner"): number {
  const today = localParts(now()).date;
  const nowMs = now().getTime();
  const WHO: Record<Activity, string> = { feed: "Mom", walk: "Emma", meds: "Mom", litter: "Emma", water: "Dad", groom: "Emma", other: "Dad" };
  let n = 0;
  for (const pet of db.pets) {
    pet.routine.forEach((r, i) => {
      const label = r.label ?? r.activity;
      if (keepOpen(pet.name, label)) return;
      const m = hhmmToMinutes(r.time) + 3 + ((i * 5) % 9);
      const time = `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const at = localToDate(today, time);
      if (at.getTime() >= nowMs) return;
      const by = pet.routine.filter((x) => x.activity === r.activity).length > 1 && r.activity === "feed" && hhmmToMinutes(r.time) < 720 ? "Dad" : WHO[r.activity];
      insert("event", { id: newId("evt"), petId: pet.id, activity: r.activity, by, at: at.toISOString() });
      n++;
    });
  }
  return n;
}

function seedHistory(): void {
  const [mochi, biscuit] = db.pets;
  const pastDays = lastNLocalDates(7).slice(0, 6); // the 6 days before today
  const jitter = (hhmm: string, add: number) => {
    const m = hhmmToMinutes(hhmm) + add;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const log = (pet: Pet, activity: Activity, by: string, date: string, time: string) =>
    insert("event", { id: newId("evt"), petId: pet.id, activity, by, at: localToDate(date, time).toISOString() });

  pastDays.forEach((date, i) => {
    const daysAgo = pastDays.length - i;
    const j = (i * 7) % 12; // a few minutes of natural variation
    log(mochi, "feed", i % 2 ? "Dad" : "Emma", date, jitter("08:00", j));
    if (daysAgo !== 3) log(mochi, "feed", "Mom", date, jitter("18:00", j));
    if (daysAgo !== 5) log(mochi, "litter", "Emma", date, jitter("20:00", j));

    log(biscuit, "feed", "Dad", date, jitter("07:30", j));
    log(biscuit, "walk", "Dad", date, jitter("07:45", j));
    log(biscuit, "meds", "Mom", date, jitter("09:00", j));
    log(biscuit, "feed", "Mom", date, jitter("17:30", j));
    log(biscuit, "walk", i % 2 ? "Emma" : "Dad", date, jitter("19:00", j));
  });

  const noteDay = pastDays[pastDays.length - 2];
  insert("note", {
    id: newId("note"),
    petId: mochi.id,
    text: "ate less than usual at dinner",
    by: "Mom",
    at: localToDate(noteDay, "18:30").toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export class PetCheckError extends Error {}

export function listPets(): Pet[] {
  return db.pets;
}

/** Find a pet by name (case-insensitive). If no name is given and there is exactly one pet, use it. */
export function findPet(name?: string): Pet {
  if (!name || !name.trim()) {
    if (db.pets.length === 1) return db.pets[0];
    if (db.pets.length === 0) throw new PetCheckError("No pets have been added yet. Try: add our cat Mochi.");
    throw new PetCheckError(`Which pet? You have ${joinNames(db.pets.map((p) => p.name))}.`);
  }
  const pet =
    db.pets.find((p) => p.name.toLowerCase() === name.trim().toLowerCase()) ?? bySpecies(name.trim()) ?? fuzzyPet(name.trim());
  if (!pet) {
    const known = db.pets.length ? ` I know ${joinNames(db.pets.map((p) => p.name))}.` : "";
    throw new PetCheckError(`I don't know a pet called ${name}.${known}`);
  }
  return pet;
}

/** "dad" -> "Dad", "mary jane" -> "Mary Jane"; empty -> "Someone". */
function personName(raw?: string): string {
  const t = raw?.trim();
  if (!t) return "Someone";
  return t.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** "the cat" → the household's only cat (if there is exactly one). */
function bySpecies(word: string): Pet | undefined {
  const w = word.toLowerCase().replace(/^the\s+/, "");
  const species = /^(cat|kitty|kitten)s?$/.test(w) ? "cat" : /^(dog|puppy|pup)s?$/.test(w) ? "dog" : w;
  const matches = db.pets.filter((p) => p.species === species);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Voice input mangles names ("mocha", "Mochie", "biscuits"). Accept a unique pet whose
 * name is within a small edit distance, or that the spoken word starts with.
 */
function fuzzyPet(spoken: string): Pet | undefined {
  const s = spoken.toLowerCase().replace(/[^a-z]/g, "");
  if (s.length < 3) return undefined;
  const scored = db.pets
    .map((p) => {
      const n = p.name.toLowerCase();
      const d = n.startsWith(s) || s.startsWith(n) ? 0 : editDistance(s, n);
      return { p, d };
    })
    .filter((x) => x.d <= (x.p.name.length >= 5 ? 2 : 1))
    .sort((a, b) => a.d - b.d);
  if (scored.length === 0) return undefined;
  if (scored.length > 1 && scored[0].d === scored[1].d) return undefined; // ambiguous
  return scored[0].p;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function minutesAgo(iso: string): number {
  return Math.round((now().getTime() - new Date(iso).getTime()) / 60_000);
}

function eventsOn(petId: string, localDate: string): CareEvent[] {
  return db.events
    .filter((e) => e.petId === petId && localParts(new Date(e.at)).date === localDate)
    .sort((a, b) => a.at.localeCompare(b.at));
}

// ---------------------------------------------------------------------------
// Tool logic
// ---------------------------------------------------------------------------

export function addPet(input: { name: string; species: string; routine?: RoutineItem[]; createdOn?: string }): {
  pet: Pet;
  message: string;
} {
  const name = input.name.trim();
  if (db.pets.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new PetCheckError(`${name} is already set up.`);
  }
  for (const r of input.routine ?? []) {
    if (!/^\d{1,2}:\d{2}$/.test(r.time)) throw new PetCheckError(`Routine time "${r.time}" should look like 08:00.`);
  }
  const pet: Pet = {
    id: newId("pet"),
    name,
    species: input.species.trim().toLowerCase(),
    routine: [...(input.routine ?? [])].sort((a, b) => hhmmToMinutes(a.time) - hhmmToMinutes(b.time)),
    createdOn: input.createdOn ?? localParts(now()).date,
  };
  insert("pet", pet);
  const routineText = pet.routine.length
    ? ` Routine: ${pet.routine.map((r) => `${r.label ?? r.activity} at ${minutesToSpoken(hhmmToMinutes(r.time))}`).join(", ")}.`
    : "";
  return { pet, message: `Added ${pet.name} the ${pet.species}.${routineText}` };
}

export type LogCareResult =
  | { status: "logged"; event: CareEvent; message: string }
  | { status: "needs_confirmation"; previous: CareEvent; message: string };

export function logCare(input: {
  pet?: string;
  activity: Activity;
  by?: string;
  detail?: string;
  confirm?: boolean;
}): LogCareResult {
  const pet = findPet(input.pet);
  const by = personName(input.by);

  // Duplicate check: the same task for the same pet within the window.
  const recent = db.events
    .filter((e) => e.petId === pet.id && e.activity === input.activity && minutesAgo(e.at) <= DUPLICATE_WINDOW_MIN)
    .sort((a, b) => b.at.localeCompare(a.at))[0];

  if (recent && !input.confirm) {
    const ago = minutesAgo(recent.at);
    const who = recent.by.toLowerCase() === by.toLowerCase() ? "You" : recent.by;
    return {
      status: "needs_confirmation",
      previous: recent,
      message:
        `${who} already ${verbFor(input.activity)} ${pet.name} at ${spokenTime(new Date(recent.at))}, ` +
        `${ago <= 1 ? "just a minute" : `${ago} minutes`} ago. Do you want me to log it again?`,
    };
  }

  const event: CareEvent = {
    id: newId("evt"),
    petId: pet.id,
    activity: input.activity,
    by,
    at: now().toISOString(),
    detail: input.detail,
  };
  insert("event", event);
  return {
    status: "logged",
    event,
    message: `Got it. ${by} ${verbFor(input.activity)} ${pet.name} at ${spokenTime(now())}.`,
  };
}

function verbFor(a: Activity): string {
  return {
    feed: "fed",
    walk: "walked",
    meds: "gave medication to",
    litter: "cleaned the litter for",
    water: "refilled water for",
    groom: "groomed",
    other: "logged care for",
  }[a];
}

export interface SlotStatus {
  activity: Activity;
  label: string;
  time: string;
  state: "done" | "due" | "overdue" | "upcoming";
  doneBy?: string;
  doneAt?: string;
}

/**
 * Today's routine for one pet. Events are matched to routine slots of the same
 * activity in time order: the first feed of the day satisfies breakfast, the
 * second satisfies dinner, and so on.
 */
/** A task logged up to this long before its scheduled time counts as on time ("fed at 5:30 for 6 PM dinner"). */
const EARLY_WINDOW_MIN = 60;

/**
 * Match a day's logged events to routine slots. Each event (in time order) fills the
 * nearest open slot of the same activity that is already due (or due within the next
 * hour), so a 2:48 PM feeding is a late breakfast if breakfast was missed, and a 7 PM
 * feeding is dinner. Only if nothing earlier is open does it count toward a later slot.
 * Returns the matched event (or undefined) per routine item.
 */
function matchEvents(routine: RoutineItem[], events: CareEvent[]): (CareEvent | undefined)[] {
  const matched: (CareEvent | undefined)[] = routine.map(() => undefined);
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const eMin = localParts(new Date(e.at)).minutes;
    const open = routine
      .map((r, i) => ({ i, slotMin: hhmmToMinutes(r.time), r }))
      .filter(({ r, i }) => r.activity === e.activity && !matched[i]);
    if (open.length === 0) continue;
    const dueByNow = open.filter((o) => o.slotMin <= eMin + EARLY_WINDOW_MIN);
    const pool = dueByNow.length ? dueByNow : open;
    pool.sort((a, b) => Math.abs(a.slotMin - eMin) - Math.abs(b.slotMin - eMin));
    matched[pool[0].i] = e;
  }
  return matched;
}

export function todaySlots(pet: Pet): SlotStatus[] {
  const { date, minutes: nowMin } = localParts(now());
  const matches = matchEvents(pet.routine, eventsOn(pet.id, date));
  return pet.routine.map((r, i) => {
    const match = matches[i];
    const slotMin = hhmmToMinutes(r.time);
    const base = { activity: r.activity, label: r.label ?? r.activity, time: r.time };
    if (match) {
      return { ...base, state: "done" as const, doneBy: match.by, doneAt: match.at };
    }
    if (nowMin >= slotMin + OVERDUE_GRACE_MIN) return { ...base, state: "overdue" as const };
    if (nowMin >= slotMin) return { ...base, state: "due" as const };
    return { ...base, state: "upcoming" as const };
  });
}

export function getStatus(input: { pet?: string }): { pets: { pet: string; slots: SlotStatus[] }[]; message: string } {
  const pets = input.pet ? [findPet(input.pet)] : db.pets;
  if (pets.length === 0) throw new PetCheckError("No pets have been added yet.");
  const result = pets.map((p) => ({ pet: p.name, slots: todaySlots(p) }));
  const sentences = result.map(({ pet, slots }) => {
    if (slots.length === 0) return `${pet} has no routine set up.`;
    const done = slots.filter((s) => s.state === "done");
    const late = slots.filter((s) => s.state === "overdue" || s.state === "due");
    const next = slots.find((s) => s.state === "upcoming");
    const parts: string[] = [];
    if (done.length) {
      parts.push(
        `${pet} has had ${joinNames(done.map((s) => `${s.label} (${s.doneBy}, ${spokenTime(new Date(s.doneAt!))})`))}`,
      );
    } else {
      parts.push(`Nothing has been logged for ${pet} yet today`);
    }
    if (late.length) parts.push(`still waiting on ${joinNames(late.map((s) => `${s.label} from ${minutesToSpoken(hhmmToMinutes(s.time))}`))}`);
    if (next) parts.push(`next up is ${next.label} at ${minutesToSpoken(hhmmToMinutes(next.time))}`);
    return parts.join("; ") + ".";
  });
  const upcomingVisits = db.visits.filter((v) => pets.some((p) => p.id === v.petId) && v.date === localParts(now()).date);
  const visitText = upcomingVisits.length
    ? ` Vet visit today${upcomingVisits[0].time ? ` at ${minutesToSpoken(hhmmToMinutes(upcomingVisits[0].time))}` : ""}.`
    : "";
  return { pets: result, message: sentences.join(" ") + visitText };
}

export function addNote(input: { pet?: string; text: string; by?: string }): { note: Note; message: string } {
  const pet = findPet(input.pet);
  const note: Note = {
    id: newId("note"),
    petId: pet.id,
    text: input.text.trim(),
    by: personName(input.by),
    at: now().toISOString(),
  };
  insert("note", note);
  const week = new Set(lastNLocalDates(7));
  const weekCount = db.notes.filter((n) => n.petId === pet.id && week.has(localParts(new Date(n.at)).date)).length;
  return {
    note,
    message:
      `Noted for ${pet.name}.` +
      (weekCount > 1 ? ` That's ${weekCount} notes about ${pet.name} this week.` : "") +
      ` If you're worried, it's worth checking with your vet.`,
  };
}

export function addVetVisit(input: { pet?: string; date: string; time?: string; reason?: string }): {
  visit: VetVisit;
  message: string;
} {
  const pet = findPet(input.pet);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new PetCheckError(`Date "${input.date}" should look like 2026-10-06.`);
  if (input.time && !/^\d{1,2}:\d{2}$/.test(input.time)) throw new PetCheckError(`Time "${input.time}" should look like 10:00.`);
  const visit: VetVisit = { id: newId("vet"), petId: pet.id, date: input.date, time: input.time, reason: input.reason };
  insert("visit", visit);
  return {
    visit,
    message:
      `Vet visit for ${pet.name} on ${spokenDate(input.date)}` +
      (input.time ? ` at ${minutesToSpoken(hhmmToMinutes(input.time))}` : "") +
      (input.reason ? ` for ${input.reason}` : "") +
      `. I'll remind you the day before.`,
  };
}

export function weeklySummary(input: { pet?: string }): { message: string; stats: unknown } {
  const pet = findPet(input.pet);
  const dates = lastNLocalDates(7).filter((d) => d >= pet.createdOn);
  const today = dates[dates.length - 1];
  const { minutes: nowMin } = localParts(now());
  const period =
    dates.length === 7 ? "This week" : dates.length === 1 ? "Today" : `Since ${weekdayName(new Date(`${dates[0]}T12:00:00Z`), "UTC")}`;

  const byActivity = new Map<Activity, { done: number; expected: number }>();
  const missed = new Map<string, string[]>(); // label -> weekday names
  const helpers = new Map<string, number>();

  for (const date of dates) {
    const events = eventsOn(pet.id, date);
    for (const e of events) helpers.set(e.by, (helpers.get(e.by) ?? 0) + 1);
    const matches = matchEvents(pet.routine, events);
    pet.routine.forEach((r, i) => {
      // Only count today's slots that are already past due (or already done).
      if (date === today && !matches[i] && nowMin < hhmmToMinutes(r.time) + OVERDUE_GRACE_MIN) return;
      const stat = byActivity.get(r.activity) ?? { done: 0, expected: 0 };
      stat.expected++;
      if (matches[i]) {
        stat.done++;
      } else {
        const label = r.label ?? r.activity;
        missed.set(label, [...(missed.get(label) ?? []), relativeDay(date)]);
      }
      byActivity.set(r.activity, stat);
    });
  }

  const weekSet = new Set(dates);
  const notes = db.notes.filter((n) => n.petId === pet.id && weekSet.has(localParts(new Date(n.at)).date));
  const upcoming = db.visits
    .filter((v) => v.petId === pet.id && v.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const parts: string[] = [];
  const statText = [...byActivity.entries()].map(
    ([a, s]) => `${activityNoun(a)} ${s.done} of ${s.expected} time${s.expected === 1 ? "" : "s"}`,
  );
  parts.push(statText.length ? `${period} ${pet.name} was ${joinNames(statText)}.` : `${pet.name} has no routine set up.`);
  if (missed.size) {
    const items = [...missed.entries()].map(([label, days]) =>
      days.length <= 2
        ? `${label} ${joinNames(days.map((d) => (d === "today" || d === "yesterday" ? d : `on ${d}`)))}`
        : `${label} ${days.length} times`,
    );
    parts.push(`Missed ${joinNames(items)}.`);
  }
  if (notes.length) {
    parts.push(`Notes: ${joinNames(notes.map((n) => {
      const day = relativeDay(localParts(new Date(n.at)).date);
      return `"${n.text}" ${day === "today" || day === "yesterday" ? day : `on ${day}`}`;
    }))}.`);
  }
  const top = [...helpers.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) parts.push(`${top[0]} helped the most, with ${top[1]} tasks.`);
  if (upcoming.length) {
    const v = upcoming[0];
    parts.push(`Next vet visit: ${spokenDate(v.date)}${v.time ? ` at ${minutesToSpoken(hhmmToMinutes(v.time))}` : ""}.`);
  }

  return {
    message: parts.join(" "),
    stats: {
      pet: pet.name,
      from: dates[0],
      to: today,
      byActivity: Object.fromEntries(byActivity),
      missed: Object.fromEntries(missed),
      notes: notes.map((n) => ({ text: n.text, by: n.by, at: n.at })),
      helpers: Object.fromEntries(helpers),
      upcomingVisits: upcoming,
    },
  };
}

/** Local date -> "today", "yesterday" or a weekday name. */
function relativeDay(date: string): string {
  const days = lastNLocalDates(2);
  if (date === days[1]) return "today";
  if (date === days[0]) return "yesterday";
  return weekdayName(new Date(`${date}T12:00:00Z`), "UTC");
}

function activityNoun(a: Activity): string {
  return {
    feed: "fed",
    walk: "walked",
    meds: "given medication",
    litter: "had litter cleaned",
    water: "had water refilled",
    groom: "groomed",
    other: "cared for",
  }[a];
}

/** Overdue routine tasks right now (used by tests and the household view). */
export function overdueTasks(): { pet: string; label: string; time: string }[] {
  return db.pets.flatMap((p) =>
    todaySlots(p)
      .filter((s) => s.state === "overdue")
      .map((s) => ({ pet: p.name, label: s.label, time: s.time })),
  );
}

/** Test hook: insert an event at a specific time. */
export function _insertEvent(e: Omit<CareEvent, "id">): void {
  insert("event", { ...e, id: newId("evt") });
}

// ---------------------------------------------------------------------------
// Missed-task alerts (run every few minutes by EventBridge Scheduler)
// ---------------------------------------------------------------------------

/**
 * Look at today's routine for every pet and raise alerts for tasks that are
 * still not logged:
 *   +30 min  → "household" reminder (spoken/shown to everyone at home)
 *   +60 min  → "owner" alert (also sent by email/SMS via SNS)
 * Each (task, level) alert is raised once, so running this every 5 minutes is safe.
 * Tasks more than MAX_ALERT_AGE_MIN late are ignored.
 * Returns only the alerts created by this run.
 */
export function checkMissedTasks(): Alert[] {
  const { date, minutes: nowMin } = localParts(now());
  const raised: Alert[] = [];
  for (const pet of db.pets) {
    for (const s of todaySlots(pet)) {
      if (s.state === "done") continue;
      const late = nowMin - hhmmToMinutes(s.time);
      if (late > MAX_ALERT_AGE_MIN) continue;
      const slot = `${s.label}@${s.time}`;
      const levels: AlertLevel[] = [];
      if (late >= REMIND_AFTER_MIN) levels.push("household");
      if (late >= ESCALATE_AFTER_MIN) levels.push("owner");
      for (const level of levels) {
        const exists = db.alerts.some(
          (a) => a.petId === pet.id && a.date === date && a.slot === slot && a.level === level,
        );
        if (exists) continue;
        const due = minutesToSpoken(hhmmToMinutes(s.time));
        const alert: Alert = {
          id: newId("alert"),
          petId: pet.id,
          pet: pet.name,
          level,
          date,
          slot,
          label: s.label,
          time: s.time,
          at: now().toISOString(),
          message:
            level === "household"
              ? `Reminder: ${pet.name}'s ${s.label} was due at ${due} and hasn't been logged yet.`
              : `${pet.name} still hasn't had ${s.label}. It was due at ${due}, ${lateText(late)} ago.`,
        };
        insert("alert", alert);
        raised.push(alert);
      }
    }
  }
  return raised;
}

function lateText(min: number): string {
  if (min < 90) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hour${h > 1 ? "s" : ""} ${m} minutes` : `${h} hour${h > 1 ? "s" : ""}`;
}

/**
 * Today's alerts up to now(), newest first, each marked resolved if the task has since
 * been logged. Alerts raised by a demo run at a later simulated time stay hidden until
 * the view reaches that time.
 */
export function todayAlerts(): (Alert & { resolved: boolean })[] {
  const { date } = localParts(now());
  const nowIso = now().toISOString();
  const doneSlots = new Set<string>();
  for (const pet of db.pets) {
    for (const s of todaySlots(pet)) if (s.state === "done") doneSlots.add(`${pet.id}|${s.label}@${s.time}`);
  }
  return db.alerts
    .filter((a) => a.date === date && a.at <= nowIso)
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((a) => ({ ...a, resolved: doneSlots.has(`${a.petId}|${a.slot}`) }));
}

/**
 * Last 7 days for one pet (oldest first): how many routine tasks were due and done
 * each day (today counts only tasks already past due or done), plus the current
 * streak of fully completed days. Today only extends the streak once it's complete.
 */
export function petWeek(pet: Pet) {
  const dates = lastNLocalDates(7);
  const today = dates[dates.length - 1];
  const nowMin = localParts(now()).minutes;
  const days = dates.map((date) => {
    if (date < pet.createdOn) return { date, done: 0, expected: 0, tracked: false };
    const matches = matchEvents(pet.routine, eventsOn(pet.id, date));
    let done = 0;
    let expected = 0;
    pet.routine.forEach((r, i) => {
      if (date === today && !matches[i] && nowMin < hhmmToMinutes(r.time) + OVERDUE_GRACE_MIN) return;
      expected++;
      if (matches[i]) done++;
    });
    return { date, done, expected, tracked: true };
  });
  const todayComplete = matchEvents(pet.routine, eventsOn(pet.id, today)).every(Boolean) && pet.routine.length > 0;
  let streak = todayComplete ? 1 : 0;
  for (let i = days.length - 2; i >= 0; i--) {
    const d = days[i];
    if (!d.tracked || d.expected === 0 || d.done < d.expected) break;
    streak++;
  }
  return { days, streak };
}

/** Who logged how many tasks in the last 7 days, most first. */
export function weekHelpers(): { name: string; count: number }[] {
  const week = new Set(lastNLocalDates(7));
  const counts = new Map<string, number>();
  for (const e of db.events) {
    if (!week.has(localParts(new Date(e.at)).date)) continue;
    counts.set(e.by, (counts.get(e.by) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** Everything the household page needs for today, in one call. */
export function todayView() {
  const { date, minutes: nowMinutes } = localParts(now());
  const events = db.events
    .filter((e) => localParts(new Date(e.at)).date === date)
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((e) => ({ ...e, pet: db.pets.find((p) => p.id === e.petId)?.name ?? "?" }));
  const notes = db.notes
    .filter((n) => localParts(new Date(n.at)).date === date)
    .map((n) => ({ ...n, pet: db.pets.find((p) => p.id === n.petId)?.name ?? "?" }));
  return {
    date,
    nowMinutes,
    pets: db.pets.map((p) => ({ name: p.name, species: p.species, slots: todaySlots(p), week: petWeek(p) })),
    helpers: weekHelpers(),
    events,
    notes,
    alerts: todayAlerts(),
    upcomingVisits: db.visits
      .filter((v) => v.date >= date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((v) => ({ ...v, pet: db.pets.find((p) => p.id === v.petId)?.name ?? "?" })),
  };
}
