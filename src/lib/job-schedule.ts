/**
 * When a scheduled job next runs. Pure arithmetic, kept apart from the
 * database so it can be tested.
 *
 * Every time here is the curator's wall clock, India Standard Time. The host
 * runs UTC inside WSL and IST outside it, and the old cron lines had to be
 * written in UTC with a comment explaining the five and a half hours; a
 * schedule typed into the console as "Thursday, 9:00 am" means 9:00 am where
 * the person typing it is. IST has no daylight saving, so the offset is a
 * constant and none of this needs a time-zone database.
 */

export type Cadence = "daily" | "weekly" | "monthly";

export interface Schedule {
  cadence: Cadence;
  /** 0–23, IST. */
  hour: number;
  /** 0–59. */
  minute: number;
  /** Weekly only: 0 = Sunday … 6 = Saturday. */
  weekday?: number | null;
  /** Monthly only: 1–31. A month too short for it runs on its last day. */
  monthDay?: number | null;
}

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** IST wall-clock fields of an instant, read off a Date's UTC getters. */
function istParts(ms: number): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(ms + IST_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay() };
}

/** The instant of an IST wall-clock time. */
function istInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month, day, hour, minute) - IST_OFFSET_MS;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The first run strictly after `afterMs`. */
export function nextRunAt(schedule: Schedule, afterMs: number): number {
  const now = istParts(afterMs);

  if (schedule.cadence === "monthly") {
    const wanted = Math.min(31, Math.max(1, schedule.monthDay ?? 1));
    // This month, then as many following months as it takes — one is always
    // enough, the loop is only there so the clamp is recomputed per month.
    for (let step = 0; step < 3; step++) {
      const year = now.year + Math.floor((now.month + step) / 12);
      const month = (now.month + step) % 12;
      const day = Math.min(wanted, daysInMonth(year, month));
      const at = istInstant(year, month, day, schedule.hour, schedule.minute);
      if (at > afterMs) return at;
    }
  }

  const today = istInstant(now.year, now.month, now.day, schedule.hour, schedule.minute);

  if (schedule.cadence === "weekly") {
    const wanted = (((schedule.weekday ?? 0) % 7) + 7) % 7;
    const ahead = (wanted - now.weekday + 7) % 7;
    const at = today + ahead * DAY_MS;
    return at > afterMs ? at : at + 7 * DAY_MS;
  }

  return today > afterMs ? today : today + DAY_MS;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function formatTime(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

/** "Every Thursday at 9:00 am" */
export function describeSchedule(schedule: Schedule): string {
  const at = formatTime(schedule.hour, schedule.minute);
  if (schedule.cadence === "weekly") return `Every ${WEEKDAYS[(((schedule.weekday ?? 0) % 7) + 7) % 7]} at ${at}`;
  if (schedule.cadence === "monthly") return `On the ${ordinal(schedule.monthDay ?? 1)} of every month at ${at}`;
  return `Every day at ${at}`;
}

/** What is wrong with a schedule typed into the console, or null if nothing is. */
export function scheduleProblem(schedule: Schedule): string | null {
  if (!["daily", "weekly", "monthly"].includes(schedule.cadence)) return "Choose daily, weekly or monthly.";
  if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) return "The hour must be 0–23.";
  if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) return "The minute must be 0–59.";
  if (schedule.cadence === "weekly") {
    const d = schedule.weekday;
    if (d == null || !Number.isInteger(d) || d < 0 || d > 6) return "Choose a day of the week.";
  }
  if (schedule.cadence === "monthly") {
    const d = schedule.monthDay;
    if (d == null || !Number.isInteger(d) || d < 1 || d > 31) return "Choose a day of the month, 1–31.";
  }
  return null;
}
