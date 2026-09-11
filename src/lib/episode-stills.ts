import "server-only";

import { getAdminMovies } from "./admin-library-cache";
import { asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import { setItemImage } from "./jellyfin";
import { getCached, getLink, putLink, tmdbImage, type TmdbEpisode } from "./tmdb-store";

/**
 * Replaces episode artwork with TMDB's own still.
 *
 * The shape problem was fixed earlier — episode cards are 16:9 now instead of
 * cropping a landscape frame into a poster. This fixes the picture itself.
 * TheTVDB supplies 300x225 stills for the older series here, so The West Wing
 * was showing a dark, arbitrary 300px frame stretched into a card. TMDB has the
 * same episodes at 1920x1080 with the real episode title behind them.
 *
 * Jellyfin fetches the image server-side from the URL (setItemImage), so this
 * never proxies or stores image bytes. It reads only the TMDB store, so a dry
 * run costs nothing and a real run costs one Jellyfin call per episode.
 *
 * ------------------------------------------------------------------------
 * This writes to the library, and the mapping it trusts is the group's TMDB
 * link. A wrong link puts a stranger's artwork on every episode of a show —
 * which nearly happened: the naive matcher linked E.R.'s 308 files to a
 * 75-episode programme called Trauma: Life in the E.R. tmdb-match.ts now
 * refuses anything short of an exact name plus a sane episode count, and this
 * module deliberately does no matching of its own.
 * ------------------------------------------------------------------------
 */

/** w780 is sharp on a 288px card at 2x and a fraction of the bytes of the original. */
const STILL_SIZE = "w780";

export interface StillPlanEntry {
  itemId: string;
  path: string;
  group: string;
  season: number;
  episode: number;
  title: string;
  stillUrl: string;
}

export interface StillPlan {
  entries: StillPlanEntry[];
  /** Already carrying their TMDB still, so not re-applied. */
  alreadyDone: number;
  skipped: {
    /** Group has no confident TMDB link, so nothing here is safe to touch. */
    unlinkedGroups: string[];
    /** Filename carries no season/episode marker. */
    unparsed: number;
    /** Parsed fine, but TMDB has no such episode — a numbering mismatch. */
    noEpisode: number;
    /** TMDB knows the episode but has no still for it. */
    noStill: number;
  };
  /**
   * The files behind the skipped counts, for the console's worklist. A count
   * says there is a problem; only the list says which episodes to go and fix.
   */
  details: {
    unparsed: string[];
    noEpisode: Array<{ path: string; group: string; season: number; episode: number }>;
    noStill: Array<{ path: string; group: string; season: number; episode: number; title: string }>;
  };
}

interface GroupRow {
  group_id: string;
  group_name: string;
  path: string;
}

/**
 * Works out what would change, touching nothing.
 *
 * Separate from applying it because the interesting failure here is a silent
 * mis-mapping — an off-by-one in episode numbering puts the wrong still on
 * every episode of a season, and it looks fine until you watch one. A plan you
 * can read first is the cheapest guard against that.
 */
export function planEpisodeStills(options: { groupId?: string; force?: boolean } = {}): StillPlan {
  const plan: StillPlan = {
    entries: [],
    alreadyDone: 0,
    skipped: { unlinkedGroups: [], unparsed: 0, noEpisode: 0, noStill: 0 },
    details: { unparsed: [], noEpisode: [], noStill: [] },
  };

  const rows = asRows<GroupRow>(
    getDb()
      .prepare(
        options.groupId
          ? "SELECT group_id, group_name, path FROM library_groups WHERE group_id = ?"
          : "SELECT group_id, group_name, path FROM library_groups",
      )
      .all(...(options.groupId ? [options.groupId] : [])),
  );

  const byGroup = new Map<string, { name: string; paths: string[] }>();
  for (const r of rows) {
    const entry = byGroup.get(r.group_id) ?? { name: r.group_name, paths: [] };
    entry.paths.push(r.path);
    byGroup.set(r.group_id, entry);
  }

  for (const [groupId, group] of byGroup) {
    const link = getLink("group", groupId);
    if (!link || link.tmdbKind !== "tv") {
      plan.skipped.unlinkedGroups.push(group.name);
      continue;
    }

    // Season payloads, indexed by season then episode number.
    const seasons = new Map<number, Map<number, TmdbEpisode>>();
    const loadSeason = (n: number) => {
      if (seasons.has(n)) return seasons.get(n)!;
      const cached = getCached<{ episodes?: TmdbEpisode[] }>("season", link.tmdbId, n);
      const map = new Map<number, TmdbEpisode>();
      for (const ep of cached?.payload.episodes ?? []) map.set(ep.episode_number, ep);
      seasons.set(n, map);
      return map;
    };

    for (const path of group.paths) {
      /* Applied stills are recorded, because the plan is otherwise stateless:
         without this every run re-plans all 620 and a budgeted loop keeps
         redoing the same first N forever, which is exactly what happened. */
      if (!options.force && getLink("still", path)) {
        plan.alreadyDone += 1;
        continue;
      }
      const parsed = parseEpisodeInfo(path);
      if (parsed.season == null || parsed.episode == null) {
        plan.skipped.unparsed += 1;
        plan.details.unparsed.push(path);
        continue;
      }
      const ep = loadSeason(parsed.season).get(parsed.episode);
      if (!ep) {
        plan.skipped.noEpisode += 1;
        plan.details.noEpisode.push({
          path,
          group: group.name,
          season: parsed.season,
          episode: parsed.episode,
        });
        continue;
      }
      const url = tmdbImage(ep.still_path, STILL_SIZE);
      if (!url) {
        plan.skipped.noStill += 1;
        plan.details.noStill.push({
          path,
          group: group.name,
          season: parsed.season,
          episode: parsed.episode,
          title: ep.name,
        });
        continue;
      }
      plan.entries.push({
        itemId: "",
        path,
        group: group.name,
        season: parsed.season,
        episode: parsed.episode,
        title: ep.name,
        stillUrl: url,
      });
    }
  }

  return plan;
}

export interface StillApplyResult {
  applied: number;
  failed: number;
  unresolved: number;
  planned: number;
}

/**
 * Applies the plan, one Jellyfin call per episode.
 *
 * Budgeted like everything else that touches an upstream in bulk: Jellyfin
 * downloads each image itself, and asking it to do six hundred of those at once
 * on an i3 while the site is serving is how a cosmetic improvement becomes an
 * outage.
 */
export async function applyEpisodeStills(
  options: { groupId?: string; budget?: number; force?: boolean } = {},
): Promise<StillApplyResult> {
  const budget = options.budget ?? 100;
  const plan = planEpisodeStills({ groupId: options.groupId, force: options.force });
  const result: StillApplyResult = { applied: 0, failed: 0, unresolved: 0, planned: plan.entries.length };

  // Paths are the stable key here; Jellyfin item ids are what the API needs.
  const movies = await getAdminMovies({ withMediaSources: false }).catch(() => []);
  const idByPath = new Map(movies.filter((m) => m.Path).map((m) => [m.Path as string, m.Id]));

  for (const entry of plan.entries) {
    if (result.applied + result.failed >= budget) break;
    const itemId = idByPath.get(entry.path);
    if (!itemId) {
      result.unresolved += 1;
      continue;
    }
    try {
      await setItemImage(itemId, entry.stillUrl);
      putLink({
        subjectType: "still",
        subjectId: entry.path,
        tmdbKind: "tv",
        tmdbId: 0,
        season: entry.season,
        episode: entry.episode,
        resolvedBy: "still",
      });
      result.applied += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
