/**
 * Coming soon, as viewers see it: the curator's announcements and the
 * library's scheduled releases (a film's date, a show's next episodes, a
 * franchise's next film), in one list. Pure, so it is tested directly;
 * coming-soon.ts reads the tables.
 *
 * Dates are India time, like everything else on the site that names one.
 */

export type ComingSoonKind = "announced" | "film" | "show" | "franchise";

export interface ComingSoonEntry {
  key: string;
  kind: ComingSoonKind;
  title: string;
  year: number | null;
  posterSrc: string | null;
  /** Where the card opens: a show's page, or this entry on /coming-soon. */
  href: string;
  /** When it arrives, when known. */
  at: number | null;
  /** "Next film · 3 to come", "New episodes · 5 to come", or null. */
  detail: string | null;
  note: string | null;
  overview: string | null;
  /** For ordering announcements with no date: newest first. */
  createdAt: number;
}

/** Dated ones soonest first, then the undated, newest announcement first. */
export function orderComingSoon(entries: readonly ComingSoonEntry[]): ComingSoonEntry[] {
  return [...entries].sort((a, b) => {
    if (a.at !== null && b.at !== null) return a.at - b.at;
    if (a.at !== null) return -1;
    if (b.at !== null) return 1;
    return b.createdAt - a.createdAt;
  });
}

const TZ = "Asia/Kolkata";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long" });
const dayMonth = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const hourMinute = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });

function daysBetween(a: number, b: number): number {
  return Math.round((Date.parse(dayKey.format(b)) - Date.parse(dayKey.format(a))) / 86_400_000);
}

/**
 * "Today, 8:00 pm", "Tomorrow", "Friday", "23 Oct", "5 Jan 2027"; or
 * "Coming soon" with no date. A time only for today, when it matters.
 */
export function whenLabel(at: number | null, now: number): string {
  if (at === null) return "Coming soon";
  const days = daysBetween(now, at);
  // ICU puts a narrow no-break space before "pm" in newer versions: a plain one, always.
  if (days <= 0) return `Today, ${hourMinute.format(at).replace(/[\u202f\u00a0]/g, " ")}`;
  if (days === 1) return "Tomorrow";
  if (days < 7) return weekday.format(at);
  const sameYear = dayKey.format(at).slice(0, 4) === dayKey.format(now).slice(0, 4);
  return (sameYear ? dayMonth : dayMonthYear).format(at);
}

/** "Next film · 3 to come" for a franchise; "New episodes · 5 to come" for a show. */
export function scheduleDetail(kind: "show" | "franchise", remaining: number): string {
  const what = kind === "show" ? (remaining === 1 ? "New episode" : "New episodes") : "Next film";
  return remaining > 1 ? `${what} · ${remaining} to come` : what;
}
