/**
 * Continue watching, with the next episode of a show in it.
 *
 * Jellyfin's own "next up" works on its Series/Season/Episode items, and this
 * library's shows are the site's own groups of files (library_groups), which
 * Jellyfin sees as unrelated films. So finishing an episode left nothing in
 * Continue watching (Nathan For You, 2026-10-22). This works it out from the
 * group's episode order and each episode's watched mark instead.
 *
 * Pure, so it is tested directly; media.ts feeds it the viewer's listing.
 */

export interface EpisodeState {
  id: string;
  /** Position in the show: parseEpisodeInfo's sortKey, then the path. */
  sortKey: number;
  path: string;
  played: boolean;
  /** When this viewer last played it (ms), or null. */
  lastPlayedMs: number | null;
}

export interface NextUp {
  id: string;
  groupId: string;
  /** When the episode before it was watched: where it sorts among Continue watching. */
  at: number;
}

/** A show untouched for this long is not offered: Jellyfin's own next-up gives up after a while too. */
export const NEXT_UP_MAX_AGE_DAYS = 90;

export function inShowOrder(episodes: readonly EpisodeState[]): EpisodeState[] {
  return [...episodes].sort((a, b) => a.sortKey - b.sortKey || a.path.localeCompare(b.path));
}

/**
 * For each show: the episode after the one watched most recently, when that
 * one was finished and the next is not yet watched. Shows with an episode
 * already part-way through (`inProgress`) are left to Continue watching's own
 * card for it, so a show never appears twice.
 */
export function nextUpEpisodes(
  shows: ReadonlyMap<string, readonly EpisodeState[]>,
  inProgress: ReadonlySet<string>,
  now: number,
): NextUp[] {
  const oldest = now - NEXT_UP_MAX_AGE_DAYS * 86_400_000;
  const out: NextUp[] = [];
  for (const [groupId, episodes] of shows) {
    if (inProgress.has(groupId)) continue;
    const ordered = inShowOrder(episodes);
    let last = -1;
    for (let i = 0; i < ordered.length; i++) {
      const at = ordered[i]!.lastPlayedMs;
      if (at !== null && (last === -1 || at > ordered[last]!.lastPlayedMs!)) last = i;
    }
    if (last === -1) continue;
    const latest = ordered[last]!;
    if (latest.lastPlayedMs! < oldest) continue;
    // Opened but not finished. Part-way through, it would be on Continue
    // watching already, and its show would be in inProgress (skipped above);
    // so here it was opened without getting a resume point (Jellyfin keeps
    // none for the first minutes), and it is still the one to watch next.
    // Before 2026-10-25 this case offered nothing at all: Nathan For You
    // S1E02, opened for a moment, left the show with no card.
    if (!latest.played) {
      out.push({ id: latest.id, groupId, at: latest.lastPlayedMs! });
      continue;
    }
    const next = ordered.slice(last + 1).find((e) => !e.played);
    if (next) out.push({ id: next.id, groupId, at: latest.lastPlayedMs! });
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The row's cards: half-watched titles and next episodes together, most
 * recent activity first, without the ones the viewer removed. A removal holds
 * until there is something newer: the title is played again, or (for a next
 * episode) a later episode of the show is watched.
 */
export function continueWatchingOrder(
  resume: ReadonlyArray<{ id: string; at: number }>,
  nextUp: readonly NextUp[],
  removed: ReadonlyMap<string, number>,
  limit: number,
): Array<{ id: string; nextUp: boolean }> {
  const kept = (id: string, at: number) => {
    const removedAt = removed.get(id);
    return removedAt === undefined || at > removedAt;
  };
  return [
    ...resume.filter((r) => kept(r.id, r.at)).map((r) => ({ id: r.id, at: r.at, nextUp: false })),
    ...nextUp.filter((n) => kept(n.id, n.at)).map((n) => ({ id: n.id, at: n.at, nextUp: true })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(({ id, nextUp }) => ({ id, nextUp }));
}
