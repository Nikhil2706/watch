import "server-only";

import { asRows, getDb } from "./db";
import { getKnownFilms } from "./known-films";
import { notifyAllUsers } from "./notifications";

/** Same cadence as the OMDb/Wikipedia backfill loops — new titles arrive far slower than this refreshes. */
export const TICK_INTERVAL_MS = 10 * 60 * 1000;

export interface LibraryNotifyStatus {
  knownItemCount: number;
  lastTickAt: number | null;
  lastTickNewItems: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateLibraryNotifyStatus: LibraryNotifyStatus | undefined;
}

/** Cheap read for the Health tab — reports whatever the last tick already computed, never triggers new work itself. */
export function getLibraryNotifyStatus(): LibraryNotifyStatus | null {
  return globalThis.__jellyfinGateLibraryNotifyStatus ?? null;
}

/**
 * Diffs the library against what this tick loop has seen before and
 * notifies every user about anything genuinely new. The very first tick
 * against an empty `known_library_items` table populates it without
 * notifying anyone — otherwise turning this on for the first time would
 * blast every user with the entire existing library at once. Only movies
 * are tracked, same scope as getKnownFilms() itself (a movie with no IMDb
 * id can't be linked to reliably, and TV shows arrive episode-by-episode
 * rather than as one clean "new item" moment, so they're left out of this
 * for now).
 */
export async function runLibraryNotifyTick(): Promise<{ newItems: number }> {
  const db = getDb();
  const isFirstRun =
    asRows<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM known_library_items").all())[0]!.n === 0;

  const films = await getKnownFilms();
  const known = new Set(
    asRows<{ imdb_id: string }>(db.prepare("SELECT imdb_id FROM known_library_items").all()).map((r) => r.imdb_id),
  );

  const insert = db.prepare(
    `INSERT INTO known_library_items (imdb_id, jellyfin_id, name, first_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(imdb_id) DO NOTHING`,
  );

  let newCount = 0;
  const now = Date.now();
  for (const film of films) {
    if (known.has(film.imdbId)) continue;
    insert.run(film.imdbId, film.jellyfinId, film.name, now);
    if (!isFirstRun) {
      notifyAllUsers({ kind: "new_item", imdbId: film.imdbId, filmTitle: film.name, filmHref: `/item/${film.jellyfinId}` });
      newCount++;
    }
  }

  const knownItemCount = asRows<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM known_library_items").all())[0]!.n;
  globalThis.__jellyfinGateLibraryNotifyStatus = { knownItemCount, lastTickAt: now, lastTickNewItems: newCount };

  return { newItems: newCount };
}
