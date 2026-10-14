/**
 * The listing rule as it was before the catalogue state (docs/catalogue-state.md
 * section 6), kept only to prove the move changes nothing: the equivalence
 * tests (catalogue-state.test.ts) run it against every combination of facts,
 * and the snapshot route (/api/admin/catalogue/snapshot) against the live
 * library. Copied from media.ts's filterVisible as it stood on 2026-10-14,
 * reduced to the facts it read, minus parental control (unchanged and still
 * applied on top). Do not "fix" it. Delete it once step 2 has been live a while.
 */

import type { ListContext } from "./catalogue-state.ts";

export interface LegacyInputs {
  specialFeature: boolean; // specialFeatures.has(item.Id)
  alternateVersion: boolean; // alternateVersions.has(item.Path)
  excluded: boolean; // excluded.has(item.Path)
  damaged: boolean; // damaged.has(item.Path): verdict damaged AND allowed = 0
  ungroupedEpisode: boolean; // isUngroupedEpisode(item, episodes)
  noMetadata: boolean; // hasNoMetadata(item)
  whitelisted: boolean; // whitelisted.has(item.Path)
  scheduled: boolean; // rolloutHiddenPaths.has(Path) || rolloutHiddenImdb.has(Imdb)
}

/** The options each caller passed, by the context the new code names it. */
export const LEGACY_OPTIONS: Record<ListContext, { requireMetadata?: boolean; includeSpecialFeatures?: boolean }> = {
  discovery: {},
  resume: { includeSpecialFeatures: true }, // getResume
  show_episodes: { requireMetadata: false }, // getCollection
};

export function legacyListed(
  i: LegacyInputs,
  options: { requireMetadata?: boolean; includeSpecialFeatures?: boolean },
): boolean {
  const requireMetadata = options.requireMetadata ?? true;
  const specialFeatures = options.includeSpecialFeatures ? null : true;
  const alternateVersions = options.includeSpecialFeatures ? null : true;
  if (specialFeatures && i.specialFeature) return false;
  if (alternateVersions && i.alternateVersion) return false;
  if (i.excluded) return false;
  if (i.damaged) return false;
  if (i.ungroupedEpisode) return false;
  if (requireMetadata && i.noMetadata && !i.whitelisted) return false;
  if (i.scheduled) return false;
  return true;
}
