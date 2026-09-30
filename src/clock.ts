// Time helpers. All timestamps are stored as UTC ISO strings; "today" and
// routine times ("08:00") are interpreted in the household's time zone.
//
// The demo offset lets the simulated Alexa+ page "fast-forward" the clock
// (e.g. jump to 6:30 PM) so the real missed-task logic runs during the video.

let demoOffsetMs = 0;

export const HOUSEHOLD_TZ = process.env.HOUSEHOLD_TZ ?? "America/Detroit";

export function now(): Date {
  return new Date(Date.now() + demoOffsetMs);
}

export function setDemoOffset(ms: number): void {
  demoOffsetMs = ms;
}

export function getDemoOffset(): number {
  return demoOffsetMs;
}

/** Local calendar date (YYYY-MM-DD) and minutes-since-midnight in the household TZ. */
export function localParts(d: Date, tz = HOUSEHOLD_TZ): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** "08:00" -> 480 */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** 480 -> "8:00 AM" (spoken-friendly) */
export function minutesToSpoken(mins: number): string {
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function spokenTime(d: Date, tz = HOUSEHOLD_TZ): string {
  return minutesToSpoken(localParts(d, tz).minutes);
}

/** The last `n` local dates ending today, oldest first. */
export function lastNLocalDates(n: number, tz = HOUSEHOLD_TZ): string[] {
  const out: string[] = [];
  const base = now().getTime();
  for (let i = n - 1; i >= 0; i--) {
    out.push(localParts(new Date(base - i * 86_400_000), tz).date);
  }
  return out;
}

export function weekdayName(d: Date, tz = HOUSEHOLD_TZ): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
}

/** Household-local date + "HH:MM" -> the real instant (handles DST via one correction pass). */
export function localToDate(date: string, hhmm: string, tz = HOUSEHOLD_TZ): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const target = hhmmToMinutes(hhmm);
  let guess = Date.UTC(y, mo - 1, d, 0, target);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), tz);
    const dayDiff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86_400_000);
    guess += (dayDiff * 1440 + target - p.minutes) * 60_000;
  }
  return new Date(guess);
}

/** "2026-10-06" -> "Tuesday, October 6" */
export function spokenDate(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}
