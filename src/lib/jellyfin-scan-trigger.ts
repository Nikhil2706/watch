/**
 * Takes Jellyfin's own schedule off its "Scan Media Library" task, so the
 * library is scanned only when the site asks (the "Library scan" job, the
 * console's Scan button), and the site checks the film drive first
 * (library-drive.ts).
 *
 * Jellyfin ships that task with a 12-hour interval trigger. Run while the
 * drive is missing, it removes every film and the item ids the site's
 * database is keyed on. Done at every boot, because a Jellyfin upgrade or
 * someone in its dashboard can put a trigger back; with none there it
 * changes nothing.
 *
 * Every trigger goes, not only the interval one: a daily, weekly or
 * at-startup scan has the same problem. The task itself stays, so "Run" in
 * Jellyfin's dashboard still works.
 *
 * Jellyfin is passed in, so the tests can stand in for it.
 */

export interface JellyfinTask {
  Id: string;
  Key?: string;
  Name?: string;
  Triggers?: Array<{ Type?: string } & Record<string, unknown>>;
}

export type JellyfinCall = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** Jellyfin's key for "Scan Media Library". */
export const LIBRARY_SCAN_TASK_KEY = "RefreshLibrary";

export type TriggerRemoval =
  | { changed: false; reason: "no_task" | "no_triggers" }
  | { changed: true; removed: string[] };

export async function removeLibraryScanTriggers(call: JellyfinCall): Promise<TriggerRemoval> {
  const tasks = await call<JellyfinTask[]>("/ScheduledTasks?IsHidden=false");
  const task = (tasks ?? []).find((t) => t.Key === LIBRARY_SCAN_TASK_KEY);
  if (!task) return { changed: false, reason: "no_task" };
  const triggers = task.Triggers ?? [];
  if (triggers.length === 0) return { changed: false, reason: "no_triggers" };

  // The whole list is replaced; an empty one leaves the task manual-only.
  await call<void>(`/ScheduledTasks/${encodeURIComponent(task.Id)}/Triggers`, { method: "POST", body: [] });
  return { changed: true, removed: triggers.map((t) => t.Type ?? "unknown") };
}
