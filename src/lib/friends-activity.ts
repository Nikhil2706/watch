import "server-only";

import { asRows, getDb } from "./db";
import { friendsFeed, type ActivityEvent, type FriendsCard } from "./friends-feed";
import { friendsSharingWith } from "./friends";
import { listNowPlaying } from "./jellyfin";
import { getGroupedPathMap, getGroupSeriesPoster } from "./library-curation";
import { getAllMovies, type MediaItem } from "./media";
import type { ResolvedSession } from "./session";

/**
 * Home's friends rows: what friends have watched, rated and reviewed lately
 * ("Friends lately", Letterboxd-style), and what they are watching right now.
 * Who counts is friends.ts; how events become cards is friends-feed.ts.
 *
 * Everything is shown through the viewer's own listing: a title they could
 * not open themselves (parental control, hidden, removed) is left out, even
 * when a friend watched it.
 */

const LATELY_DAYS = 60;
const LATELY_CARDS = 12;

/** A card ready for Row: the item to link and draw, and how to label it. */
export interface FriendsTile {
  item: MediaItem;
  card: FriendsCard;
  /** A show's tile: its name, poster and page, rather than one episode's. */
  showName?: string;
  posterSrc?: string | null;
  href?: string;
}

/** A film's key across watches, ratings and reviews: a show's episodes and its series id meet on the show. */
function keys() {
  const showOfPath = getGroupedPathMap();
  const showOfSeriesImdb = new Map(
    asRows<{ group_id: string; imdb_id: string }>(
      getDb().prepare("SELECT group_id, imdb_id FROM library_group_series").all(),
    ).map((r) => [r.imdb_id, r.group_id]),
  );
  return {
    forWatch(itemId: string, path: string | null): string {
      const show = path ? showOfPath.get(path) : undefined;
      return show ? `group:${show.groupId}` : `item:${itemId}`;
    },
    forImdb(imdbId: string): string {
      const group = showOfSeriesImdb.get(imdbId);
      return group ? `group:${group}` : `imdb:${imdbId}`;
    },
    showOfPath,
  };
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export async function friendsLately(session: ResolvedSession): Promise<FriendsTile[]> {
  const friends = friendsSharingWith(session.userId);
  if (!friends.length) return [];
  const names = new Map(friends.map((f) => [f.id, f.username]));
  const ids = friends.map((f) => f.id);
  const since = Date.now() - LATELY_DAYS * 86_400_000;
  const k = keys();
  const db = getDb();

  const events: ActivityEvent[] = [];
  for (const r of asRows<{ user_id: string; item_id: string; path: string | null; watched_at: number }>(
    db
      .prepare(`SELECT user_id, item_id, path, watched_at FROM watch_log WHERE watched_at >= ? AND user_id IN (${placeholders(ids.length)})`)
      .all(since, ...ids),
  )) {
    events.push({ kind: "watched", userId: r.user_id, username: names.get(r.user_id)!, filmKey: k.forWatch(r.item_id, r.path), at: r.watched_at });
  }
  for (const r of asRows<{ user_id: string; imdb_id: string; score: number; updated_at: number }>(
    db
      .prepare(`SELECT user_id, imdb_id, score, updated_at FROM user_ratings WHERE updated_at >= ? AND user_id IN (${placeholders(ids.length)})`)
      .all(since, ...ids),
  )) {
    events.push({ kind: "rated", userId: r.user_id, username: names.get(r.user_id)!, filmKey: k.forImdb(r.imdb_id), at: r.updated_at, score: r.score });
  }
  for (const r of asRows<{ user_id: string; imdb_id: string; body: string; created_at: number }>(
    db
      .prepare(
        `SELECT user_id, imdb_id, body, created_at FROM film_comments
         WHERE parent_id IS NULL AND deleted_at IS NULL AND created_at >= ? AND user_id IN (${placeholders(ids.length)})`,
      )
      .all(since, ...ids),
  )) {
    events.push({ kind: "reviewed", userId: r.user_id, username: names.get(r.user_id)!, filmKey: k.forImdb(r.imdb_id), at: r.created_at, text: r.body });
  }

  // More cards than the row shows: some will be titles this viewer can't open.
  const cards = friendsFeed(events, LATELY_CARDS * 3);
  if (!cards.length) return [];

  const listing = await getAllMovies(session, { limit: 2000 });
  const byId = new Map(listing.map((i) => [i.Id, i]));
  const byImdb = new Map<string, MediaItem>();
  const firstOfShow = new Map<string, MediaItem>();
  for (const item of listing) {
    const imdb = item.ProviderIds?.Imdb;
    if (imdb && !byImdb.has(imdb)) byImdb.set(imdb, item);
    const show = item.Path ? k.showOfPath.get(item.Path) : undefined;
    if (show && !firstOfShow.has(show.groupId)) firstOfShow.set(show.groupId, item);
  }

  const tiles: FriendsTile[] = [];
  for (const card of cards) {
    const [kind, id] = [card.filmKey.slice(0, card.filmKey.indexOf(":")), card.filmKey.slice(card.filmKey.indexOf(":") + 1)];
    if (kind === "group") {
      const item = firstOfShow.get(id);
      if (!item) continue;
      const show = k.showOfPath.get(item.Path!)!;
      tiles.push({ item, card, showName: show.groupName, posterSrc: getGroupSeriesPoster(id), href: `/collection/${id}` });
    } else {
      const item = kind === "item" ? byId.get(id) : byImdb.get(id);
      if (item) tiles.push({ item, card });
    }
    if (tiles.length >= LATELY_CARDS) break;
  }
  return tiles;
}

export interface WatchingNow {
  item: MediaItem;
  friend: { id: string; username: string };
  positionSeconds: number;
  paused: boolean;
}

/** Friends playing something right now, on any device, that this viewer could open too. */
export async function friendsWatchingNow(session: ResolvedSession): Promise<WatchingNow[]> {
  const friends = friendsSharingWith(session.userId);
  if (!friends.length) return [];
  const byJellyfinUser = new Map(friends.map((f) => [f.jellyfinUserId, f]));
  const playing = (await listNowPlaying()).filter((p) => byJellyfinUser.has(p.jellyfinUserId));
  if (!playing.length) return [];
  const byId = new Map((await getAllMovies(session, { limit: 2000 })).map((i) => [i.Id, i]));
  const seen = new Set<string>();
  return playing.flatMap((p) => {
    const item = byId.get(p.itemId);
    const friend = byJellyfinUser.get(p.jellyfinUserId)!;
    // One card per friend and title, however many devices it is open on.
    const key = `${friend.id}:${p.itemId}`;
    if (!item || seen.has(key)) return [];
    seen.add(key);
    return [{ item, friend: { id: friend.id, username: friend.username }, positionSeconds: p.positionSeconds, paused: p.paused }];
  });
}
