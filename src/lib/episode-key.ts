/**
 * How an episode is named where a film would be named by its IMDb id.
 *
 * An episode of a show is a file in a library group: it has no IMDb id of its
 * own, and its Jellyfin item id does not survive a library rebuild. Its path
 * does. The curator's accolade lists are keyed on IMDb ids throughout, so an
 * episode in one carries "ep:" + its path in that column instead — a value no
 * IMDb id can collide with ("tt…"), which every lookup by id then finds or
 * misses exactly as it would a film's.
 *
 * Picks store the path in a column of its own (pick_items.item_path); this
 * key is how the console hands an episode to either.
 *
 * A film Jellyfin has no IMDb id for goes by the same key, for the same
 * reason: its path is the only name it has that lasts. It is stored exactly
 * as an episode is (kind "episode", no group), and the places that show one
 * tell the two apart by whether the file belongs to a show.
 */
const PREFIX = "ep:";

export function episodeKey(path: string): string {
  return PREFIX + path;
}

/** The path inside an episode key, or null for anything else (an IMDb id, nothing). */
export function pathFromEpisodeKey(key: string | null | undefined): string | null {
  return key && key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}

/** "S2 E22" */
export function episodeCode(season: number, episode: number): string {
  return `S${season} E${episode}`;
}
