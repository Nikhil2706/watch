import "server-only";

import type { CatalogueFacts } from "./catalogue-state";
import { getEpisodeVisibilityIndex, isUngroupedEpisode, type EpisodeVisibilityIndex } from "./episode-visibility";
import { getDamagedPathSet } from "./file-checks";
import { getAlternateVersionPathSet } from "./film-versions";
import { hasNoMetadata } from "./has-metadata";
import { getExcludedPathSet, getWhitelistedPathSet } from "./library-curation";
import { getHiddenRolloutImdbSet, getHiddenRolloutPathSet } from "./rollout";
import { getSpecialFeatureIdSet } from "./special-features";

/**
 * The facts catalogue-state.ts derives a file's state from, read in bulk from
 * the tables that hold them (docs/catalogue-state.md, 3.1).
 *
 * This is the LISTING read: exactly the eight local reads filterVisible made
 * before, and nothing the listing does not need — no plain words, no names.
 * The console's fuller read, with the details its words are built from, comes
 * with the inbox.
 */
export interface ListingSources {
  excluded: Set<string>;
  damaged: Set<string>;
  whitelisted: Set<string>;
  episodes: EpisodeVisibilityIndex;
  rolloutPaths: Set<string>;
  rolloutImdb: Set<string>;
  specialFeatureIds: Set<string>;
  alternateVersionPaths: Set<string>;
}

export function readListingSources(): ListingSources {
  return {
    excluded: getExcludedPathSet(),
    damaged: getDamagedPathSet(),
    whitelisted: getWhitelistedPathSet(),
    episodes: getEpisodeVisibilityIndex(),
    rolloutPaths: getHiddenRolloutPathSet(),
    rolloutImdb: getHiddenRolloutImdbSet(),
    specialFeatureIds: getSpecialFeatureIdSet(),
    alternateVersionPaths: getAlternateVersionPathSet(),
  };
}

export interface ListingItem {
  Id: string;
  Path?: string;
  Overview?: string | null;
  ProviderIds?: Record<string, string>;
}

export function listingFacts(item: ListingItem, s: ListingSources): CatalogueFacts {
  const path = item.Path ?? null;
  const imdb = item.ProviderIds?.Imdb;
  const on = (set: Set<string>) => !!path && set.has(path);
  return {
    path,
    itemId: item.Id,
    hasMetadata: !hasNoMetadata(item),
    whitelisted: on(s.whitelisted),
    excluded: on(s.excluded) ? {} : null,
    // The set holds only damaged files nobody has allowed.
    damaged: on(s.damaged) ? { allowed: false } : null,
    ungroupedEpisode: isUngroupedEpisode(item, s.episodes) ? {} : null,
    // Grouping changes no listing (the show's tile is made later); left out of
    // this read so it costs nothing. The console's read carries it.
    group: null,
    specialFeature: s.specialFeatureIds.has(item.Id) ? {} : null,
    alternateVersion: on(s.alternateVersionPaths) ? {} : null,
    scheduled: on(s.rolloutPaths) || (!!imdb && s.rolloutImdb.has(imdb)) ? {} : null,
    folderSuggestion: null,
    duplicate: null,
  };
}
