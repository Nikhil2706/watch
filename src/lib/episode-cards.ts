import "server-only";

import { parseEpisodeInfo } from "./episode-naming";
import { getGroupedPathMap, getGroupKind, getGroupSeriesPoster } from "./library-curation";
import type { MediaItem } from "./media";
import { episodeLine } from "./resume-labels";
import { episodeTilesForPaths } from "./tmdb-view";

/**
 * How an episode is shown in a row of things a viewer has watched (Continue
 * watching, Recently watched, History): headed with its show, carrying the
 * show's poster, and saying which episode it is on the line beneath —
 * "Buffy The Vampire Slayer" / "S1 E1 · Welcome to the Hellmouth". Its own
 * name alone, over a frame from the episode, was not recognisable.
 *
 * Films are left as they are: none of the three maps holds them.
 */
export interface EpisodeCards {
  titles: Map<string, string>;
  lines: Map<string, string>;
  posters: Map<string, string | null>;
}

export function episodeCards(items: readonly MediaItem[]): EpisodeCards {
  const showOfPath = getGroupedPathMap();
  const episodes = items.filter((i) => i.Path && showOfPath.has(i.Path));
  const names = episodeTilesForPaths(episodes.map((i) => i.Path!));
  const cards: EpisodeCards = { titles: new Map(), lines: new Map(), posters: new Map() };
  for (const item of episodes) {
    const show = showOfPath.get(item.Path!)!;
    const named = names.get(item.Path!);
    const parsed = parseEpisodeInfo(item.Path!);
    cards.titles.set(item.Id, show.groupName);
    const line = episodeLine(
      named?.seasonNumber ?? parsed.season,
      named?.episodeNumber ?? parsed.episode,
      named?.name ?? parsed.title ?? item.Name,
      getGroupKind(show.groupId) === "movie" ? { showName: show.groupName } : undefined,
    );
    if (line) cards.lines.set(item.Id, line);
    const poster = getGroupSeriesPoster(show.groupId);
    if (poster) cards.posters.set(item.Id, poster);
  }
  return cards;
}
