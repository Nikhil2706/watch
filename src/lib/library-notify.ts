import "server-only";

import { asRows, getDb } from "./db";
import { getKnownFilms } from "./known-films";
import { getConfirmedPathSet, getGroupSeriesId, listGroups } from "./library-curation";
import { notifyAllUsers } from "./notifications";
import { getHiddenRolloutPathSet } from "./rollout";
import { itemHref } from "./slugs";

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
      notifyAllUsers({ kind: "new_item", imdbId: film.imdbId, filmTitle: film.name, filmHref: itemHref(film.jellyfinId, film.name, film.year) });
      newCount++;
    }
  }

  const knownItemCount = asRows<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM known_library_items").all())[0]!.n;
  globalThis.__jellyfinGateLibraryNotifyStatus = { knownItemCount, lastTickAt: now, lastTickNewItems: newCount };

  return { newItems: newCount };
}

export interface TvNotifyStatus {
  knownGroupCount: number;
  lastTickAt: number | null;
  lastTickNewShows: number;
  lastTickEpisodeNotifications: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateTvNotifyStatus: TvNotifyStatus | undefined;
}

/** Cheap read for the Health tab, same contract as getLibraryNotifyStatus(). */
export function getTvNotifyStatus(): TvNotifyStatus | null {
  return globalThis.__jellyfinGateTvNotifyStatus ?? null;
}

/**
 * The TV-show sibling of runLibraryNotifyTick(), left out of that function's
 * scope on purpose (see its own comment) because a TV show doesn't have one
 * clean "new item" moment — it arrives as a group of episode files, curated
 * and linked to a real series over time, then keeps growing as more of the
 * grouped files get their metadata fetched.
 *
 * A "TV show" here is any library_groups entry with a linked
 * library_group_series row: an admin has confirmed it represents a real OMDb
 * series, as opposed to an arbitrary multi-file grouping (a clip
 * compilation, an alternate-cut set) that was never linked to one. Its
 * "episode count" is how many of the group's member paths currently have
 * confirmed metadata (getConfirmedPathSet()) AND not currently gated by an
 * un-arrived rollout slot (getHiddenRolloutPathSet(), rollout.ts) — i.e. how
 * many episodes are actually visible to a viewer right now, not how many
 * files exist. This is also what makes a scheduled rollout's reveal tick
 * (runRolloutRevealTick() in rollout.ts) produce a notification at all: that
 * tick only flips the gate, it never calls notifyAllUsers itself — the next
 * time this tick runs, the revealed path counts as confirmed-and-visible for
 * the first time and falls out naturally as "new episodes."
 *
 * Same first-run seeding as the movie tick: a database with no
 * known_library_groups rows yet populates the snapshot without notifying
 * anyone, so turning this on doesn't announce every already-grouped show's
 * full episode count as "new" the moment it ships.
 */
export async function runTvNotifyTick(): Promise<{ newShows: number; episodeNotifications: number }> {
  const db = getDb();
  const isFirstRun =
    asRows<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM known_library_groups").all())[0]!.n === 0;

  const known = new Map(
    asRows<{ group_id: string; episode_count: number }>(
      db.prepare("SELECT group_id, episode_count FROM known_library_groups").all(),
    ).map((r) => [r.group_id, r.episode_count]),
  );

  const confirmed = getConfirmedPathSet();
  const rolloutHidden = getHiddenRolloutPathSet();
  const groups = listGroups();

  const upsert = db.prepare(
    `INSERT INTO known_library_groups (group_id, imdb_id, name, episode_count, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET episode_count = excluded.episode_count, updated_at = excluded.updated_at`,
  );

  let newShows = 0;
  let episodeNotifications = 0;
  const now = Date.now();

  for (const group of groups) {
    const imdbId = getGroupSeriesId(group.groupId);
    if (!imdbId) continue; // not linked to a real series — not a "TV show" for this purpose

    const episodeCount = group.paths.reduce((n, p) => n + (confirmed.has(p) && !rolloutHidden.has(p) ? 1 : 0), 0);
    const previousCount = known.get(group.groupId);
    const href = `/collection/${group.groupId}`;

    if (previousCount === undefined) {
      upsert.run(group.groupId, imdbId, group.groupName, episodeCount, now, now);
      if (!isFirstRun && episodeCount > 0) {
        notifyAllUsers({ kind: "new_show", imdbId, filmTitle: group.groupName, filmHref: href });
        newShows++;
      }
    } else if (episodeCount > previousCount) {
      upsert.run(group.groupId, imdbId, group.groupName, episodeCount, now, now);
      if (!isFirstRun) {
        notifyAllUsers({
          kind: "new_episodes",
          imdbId,
          filmTitle: group.groupName,
          filmHref: href,
          episodeCount: episodeCount - previousCount,
        });
        episodeNotifications++;
      }
    } else if (episodeCount !== previousCount) {
      // Rare (metadata unconfirmed after being confirmed) — keep the
      // snapshot honest without notifying anyone about a show "losing"
      // episodes.
      upsert.run(group.groupId, imdbId, group.groupName, episodeCount, now, now);
    }
  }

  const knownGroupCount = asRows<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM known_library_groups").all())[0]!.n;
  globalThis.__jellyfinGateTvNotifyStatus = {
    knownGroupCount,
    lastTickAt: now,
    lastTickNewShows: newShows,
    lastTickEpisodeNotifications: episodeNotifications,
  };

  return { newShows, episodeNotifications };
}

/**
 * Flips a scheduled watch party live once its scheduled_at arrives, and
 * fires the "starting now" notification — the instant-party path already
 * notifies at creation time (POST /api/party/create), so this only ever
 * touches rooms that were created with a future scheduledAt. No first-run
 * seeding needed the way the two ticks above have: a party can only be
 * scheduled going forward from whenever this feature shipped, so there's
 * no pre-existing backlog to accidentally blast notifications for.
 */
export async function runPartyScheduleTick(): Promise<{ started: number }> {
  const db = getDb();
  const now = Date.now();

  const due = asRows<{ id: string; jellyfin_id: string; film_title: string }>(
    db
      .prepare(
        `SELECT id, jellyfin_id, film_title FROM party_rooms
          WHERE started_at IS NULL AND ended_at IS NULL AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
      )
      .all(now),
  );

  for (const room of due) {
    db.prepare("UPDATE party_rooms SET started_at = ? WHERE id = ?").run(now, room.id);
    notifyAllUsers({
      kind: "watch_party_live",
      imdbId: room.jellyfin_id,
      filmTitle: room.film_title,
      filmHref: `/party/${room.id}`,
    });
  }

  return { started: due.length };
}
