/**
 * A viewer's watch history, as the History page shows it: newest first, in
 * one section per month, each card dated. Pure, so it is tested directly; the
 * page fetches the items (media.ts getRecentlyWatched) and renders these.
 *
 * Months and days are India time, like everything else on the site that
 * names a date.
 */

const TIME_ZONE = "Asia/Kolkata";

const monthFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, month: "long", year: "numeric" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, day: "numeric", month: "short" });

export interface Watched {
  Id: string;
  UserData?: { LastPlayedDate?: string };
}

export interface HistoryMonth<T> {
  /** "October 2026", or "Earlier" for anything Jellyfin has no date for. */
  label: string;
  items: T[];
}

function playedAt(item: Watched): number | null {
  const iso = item.UserData?.LastPlayedDate;
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Sections in the order given (newest first), undated ones last under "Earlier". */
export function groupByMonth<T extends Watched>(items: readonly T[]): HistoryMonth<T>[] {
  return groupByMonthOf(items, playedAt);
}

/** The same, for anything with a time of its own (a friend's diary entries). */
export function groupByMonthOf<T>(items: readonly T[], timeOf: (item: T) => number | null): HistoryMonth<T>[] {
  const months: HistoryMonth<T>[] = [];
  const undated: T[] = [];
  for (const item of items) {
    const at = timeOf(item);
    if (at === null) {
      undated.push(item);
      continue;
    }
    const label = monthFormat.format(at);
    const last = months.at(-1);
    if (last?.label === label) last.items.push(item);
    else months.push({ label, items: [item] });
  }
  if (undated.length) months.push({ label: "Earlier", items: undated });
  return months;
}

/** "22 Oct" for a time in ms. */
export function dayOf(ms: number): string {
  return dayFormat.format(ms);
}

/** "22 Oct", or null when there is no date. */
export function watchedOn(item: Watched): string | null {
  const at = playedAt(item);
  return at === null ? null : dayFormat.format(at);
}
