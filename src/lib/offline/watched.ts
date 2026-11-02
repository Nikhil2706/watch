import type { Fetcher, KeyValueStore } from "./pending";

/**
 * What was watched on this device with no connection, until it can be told.
 *
 * Offline, the player's reports to Jellyfin fail and were simply dropped: on
 * 2026-11-02 Buffy episodes watched in airplane mode never reached Recently
 * watched or the history, and a download always started again at 0:00. Every
 * report from the Downloads player now also lands here, one entry per title
 * (the last position and when, and when it was last finished), and is handed
 * to Jellyfin once there is a network, with the times it actually happened.
 *
 * Everything the site counts as watched — Recently watched, History, the
 * diary, friends' feeds (watch-log.ts) — comes from Jellyfin's Played and
 * LastPlayedDate, so writing those is the whole job.
 *
 * Never older over newer: an entry is applied only where Jellyfin's own last
 * play is earlier, so watching the same film online afterwards is not undone
 * by a stale offline position.
 *
 * Everything is injected (storage, fetch, clock), like pending.ts, so this
 * runs under node:test with no browser.
 */

export const WATCHED_KEY = "watch.offline.watched";

/** Jellyfin's own default "played" mark (MaxResumePct, 90%). */
export const FINISHED_FRACTION = 0.9;

/** Reports earlier than this into a title say nothing about where it was left. */
export const MIN_POSITION_SECONDS = 5;

const TICKS_PER_SECOND = 10_000_000;

export interface OfflineWatch {
  itemId: string;
  /** Last position, in Jellyfin ticks. */
  positionTicks: number;
  /** When that position was reached (ms since 1970). */
  at: number;
  /** When it was last watched to the end (ms), or null. */
  finishedAt: number | null;
}

export function readWatched(store: KeyValueStore | null): OfflineWatch[] {
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(WATCHED_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (w): w is OfflineWatch =>
            !!w &&
            typeof w === "object" &&
            typeof (w as OfflineWatch).itemId === "string" &&
            typeof (w as OfflineWatch).positionTicks === "number" &&
            typeof (w as OfflineWatch).at === "number",
        )
      : [];
  } catch {
    return [];
  }
}

function writeWatched(store: KeyValueStore | null, list: OfflineWatch[]): void {
  if (!store) return;
  try {
    store.setItem(WATCHED_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: this one goes unrecorded, playback is unaffected.
  }
}

/**
 * One report from the player. `ended` is the media's own "ended"; a position
 * past FINISHED_FRACTION of the running time counts too, as it does for
 * Jellyfin, since credits are often skipped by closing the player.
 */
export function recordWatch(
  store: KeyValueStore | null,
  report: { itemId: string; positionSeconds: number; durationSeconds: number; ended: boolean },
  now: number,
): void {
  if (!store || !report.itemId) return;
  const finished =
    report.ended ||
    (report.durationSeconds > 0 && report.positionSeconds >= report.durationSeconds * FINISHED_FRACTION);
  // The player reports as it starts, at 0:00, before it has moved to where the
  // viewer left off; taken as a position, that would erase the one it resumes from.
  if (!finished && report.positionSeconds < MIN_POSITION_SECONDS) return;
  const list = readWatched(store);
  const previous = list.find((w) => w.itemId === report.itemId);
  const entry: OfflineWatch = {
    itemId: report.itemId,
    // A finished title resumes from the start next time, as Jellyfin does.
    positionTicks: finished ? 0 : Math.max(0, Math.round(report.positionSeconds * TICKS_PER_SECOND)),
    at: now,
    finishedAt: finished ? now : (previous?.finishedAt ?? null),
  };
  writeWatched(store, [...list.filter((w) => w.itemId !== report.itemId), entry]);
}

/** Where to start a download with no connection: its own last position, in seconds. */
export function offlineResumeSeconds(store: KeyValueStore | null, itemId: string): number {
  const entry = readWatched(store).find((w) => w.itemId === itemId);
  return entry ? Math.floor(entry.positionTicks / TICKS_PER_SECOND) : 0;
}

interface ServerUserData {
  Played?: boolean;
  LastPlayedDate?: string | null;
}

function lastPlayed(data: ServerUserData): number {
  const ms = Date.parse(data.LastPlayedDate ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Hands every waiting entry to Jellyfin through the site's /jf proxy, as the
 * signed-in viewer. An entry is dropped once it is applied or found to be
 * older than what Jellyfin has; one that fails (no network, signed out) stays
 * for the next try. Returns how many were applied.
 */
export async function syncWatched(store: KeyValueStore | null, fetcher: Fetcher): Promise<number> {
  const waiting = readWatched(store);
  if (waiting.length === 0) return 0;

  let applied = 0;
  const kept: OfflineWatch[] = [];
  for (const entry of waiting) {
    try {
      const id = encodeURIComponent(entry.itemId);
      const current = await fetcher(`/jf/UserItems/${id}/UserData`, { signal: AbortSignal.timeout(5000) });
      if (!current.ok) throw new Error(`user data ${current.status}`);
      let server = lastPlayed((await current.json()) as ServerUserData);

      if (entry.finishedAt !== null && entry.finishedAt > server) {
        const date = new Date(entry.finishedAt).toISOString();
        const marked = await fetcher(`/jf/UserPlayedItems/${id}?datePlayed=${encodeURIComponent(date)}`, {
          method: "POST",
        });
        if (!marked.ok) throw new Error(`mark played ${marked.status}`);
        server = entry.finishedAt;
        applied++;
      }

      // Watched again after finishing, and stopped part-way: that is where it
      // resumes. A position at or before the finish is already said by it.
      if (entry.at > server) {
        const updated = await fetcher(`/jf/UserItems/${id}/UserData`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            PlaybackPositionTicks: entry.positionTicks,
            LastPlayedDate: new Date(entry.at).toISOString(),
          }),
        });
        if (!updated.ok) throw new Error(`user data update ${updated.status}`);
        applied++;
      }
    } catch {
      kept.push(entry);
    }
  }
  // Re-read before writing: the player may have added to the list meanwhile.
  const now = readWatched(store);
  const sent = new Set(waiting.filter((w) => !kept.includes(w)).map((w) => `${w.itemId}@${w.at}`));
  writeWatched(
    store,
    now.filter((w) => !sent.has(`${w.itemId}@${w.at}`)),
  );
  return applied;
}
