import "server-only";

import { getAdminMovies } from "./admin-library-cache";
import { asRows, getDb } from "./db";
import { parseEpisodeInfo } from "./episode-naming";
import {
  fetchMovie,
  fetchSeason,
  fetchShow,
  findByImdbId,
  getCached,
  getLink,
  putLink,
  searchShows,
} from "./tmdb-store";
import { normaliseShowName, pickBestShowMatch } from "./tmdb-match";

/**
 * Fills the TMDB store, a bounded batch at a time.
 *
 * Budgeted and resumable, but NOT for the usual reason. TMDB imposes no daily
 * quota — their docs record the legacy 40-per-10s cap as disabled since 2019,
 * leaving an unpublished ceiling around 40 requests a second. The budget here
 * is about this host's link to them, which drops connections repeatedly: a
 * measured burst of 30 authenticated requests lost one outright and took five
 * minutes. A long synchronous run over 1,164 films on that link is not
 * something to attempt in a request.
 *
 * So: every tick does a little, records what it did, and the next tick picks up
 * where it left off by asking what is already cached rather than by keeping a
 * cursor. Nothing to corrupt, nothing to reset.
 */

/** Calls per tick. Deliberately small — see above. */
const DEFAULT_BUDGET = 40;

export interface TmdbBackfillResult {
  callsUsed: number;
  showsLinked: number;
  seasonsFetched: number;
  moviesFetched: number;
  failures: number;
  done: boolean;
  /** Groups deliberately left unlinked because no candidate was safe to act on. */
  unmatched: Array<{ group: string; files: number }>;
  note?: string;
}

interface GroupRow {
  group_id: string;
  group_name: string;
}

function libraryGroups(): GroupRow[] {
  return asRows<GroupRow>(
    getDb().prepare("SELECT DISTINCT group_id, group_name FROM library_groups ORDER BY group_name").all(),
  );
}

function groupPaths(groupId: string): string[] {
  return asRows<{ path: string }>(
    getDb().prepare("SELECT path FROM library_groups WHERE group_id = ?").all(groupId),
  ).map((r) => r.path);
}

/**
 * Which seasons a group actually has files for.
 *
 * Fetching every season TMDB knows about would pull seven seasons of a show you
 * own two of. The filenames already carry the answer — episode-naming.ts exists
 * because these are Movie items whose only reliable season/episode marker is
 * the name the file arrived with.
 */
function seasonsPresent(groupId: string): number[] {
  const seasons = new Set<number>();
  for (const path of groupPaths(groupId)) {
    const parsed = parseEpisodeInfo(path);
    if (parsed.season != null) seasons.add(parsed.season);
  }
  // A show whose files carry no season marker at all is almost always a single
  // season named without one.
  if (seasons.size === 0) seasons.add(1);
  return [...seasons].sort((a, b) => a - b);
}

export async function runTmdbBackfillTick(budget = DEFAULT_BUDGET): Promise<TmdbBackfillResult> {
  const result: TmdbBackfillResult = {
    callsUsed: 0,
    showsLinked: 0,
    seasonsFetched: 0,
    moviesFetched: 0,
    failures: 0,
    done: false,
    unmatched: [],
  };

  const spend = () => (result.callsUsed += 1);
  const spent = () => result.callsUsed >= budget;

  /* ---- shows first ------------------------------------------------
     They are the cheapest win by a wide margin: one season request returns
     every episode in it with a still, so this library's 628 episode files are
     covered by roughly thirty calls rather than 628. */
  for (const group of libraryGroups()) {
    if (spent()) return result;

    const fileCount = groupPaths(group.group_id).length;

    let link = getLink("group", group.group_id);
    if (!link) {
      try {
        const results = await searchShows(group.group_name);
        spend();

        /* Only candidates whose name matches exactly once normalised are worth
           spending a detail call on — and only a detail call reveals the
           episode count that tmdb-match needs to judge the fit. Capped at three
           so a generic title cannot turn one group into twenty requests. */
        const wanted = normaliseShowName(group.group_name);
        const plausible = results.filter((r) => normaliseShowName(r.name) === wanted).slice(0, 3);

        const candidates = [];
        for (const p of plausible) {
          if (spent()) break;
          try {
            const show = await fetchShow(p.id);
            spend();
            const payload = show.payload as { number_of_episodes?: number };
            candidates.push({
              id: p.id,
              name: p.name,
              episodeCount: payload.number_of_episodes ?? null,
              firstAirYear: p.year,
            });
          } catch {
            result.failures += 1;
          }
        }

        const best = pickBestShowMatch(candidates, { name: group.group_name, fileCount });
        if (!best) {
          // Left unlinked on purpose. A wrong link stamps another show's stills
          // across every episode; an unlinked group is one manual step.
          result.unmatched.push({ group: group.group_name, files: fileCount });
          continue;
        }

        link = {
          subjectType: "group",
          subjectId: group.group_id,
          tmdbKind: "tv",
          tmdbId: best.candidate.id,
          season: null,
          episode: null,
          resolvedBy: "search",
        };
        putLink(link);
        result.showsLinked += 1;
      } catch {
        result.failures += 1;
        continue;
      }
    }

    if (!getCached("tv", link.tmdbId)) {
      if (spent()) return result;
      try {
        await fetchShow(link.tmdbId);
        spend();
      } catch {
        result.failures += 1;
        continue;
      }
    }

    for (const season of seasonsPresent(group.group_id)) {
      if (spent()) return result;
      if (getCached("season", link.tmdbId, season)) continue;
      try {
        await fetchSeason(link.tmdbId, season);
        spend();
        result.seasonsFetched += 1;
      } catch {
        result.failures += 1;
      }
    }
  }

  /* ---- then films -------------------------------------------------
     One call each, so this is the long tail. Ordered by nothing in particular;
     "already cached" is the cursor. */
  const movies = await getAdminMovies({ withMediaSources: false }).catch(() => []);
  let remaining = 0;

  for (const movie of movies) {
    const imdb = movie.ProviderIds?.Imdb;
    if (!imdb) continue;

    const existingLink = movie.Path ? getLink("path", movie.Path) : null;
    if (existingLink && getCached("movie", existingLink.tmdbId)) continue;

    remaining += 1;
    if (spent()) continue;

    try {
      let tmdbId = Number(movie.ProviderIds?.Tmdb);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
        const found = await findByImdbId(imdb);
        spend();
        if (!found || found.kind !== "movie") continue;
        tmdbId = found.id;
      }
      if (spent()) continue;

      await fetchMovie(tmdbId);
      spend();
      result.moviesFetched += 1;
      remaining -= 1;

      if (movie.Path) {
        putLink({
          subjectType: "path",
          subjectId: movie.Path,
          tmdbKind: "movie",
          tmdbId,
          season: null,
          episode: null,
          resolvedBy: movie.ProviderIds?.Tmdb ? "tmdb-id" : "imdb",
        });
      }
    } catch {
      result.failures += 1;
    }
  }

  result.done = remaining === 0;
  if (result.done) result.note = "Everything with an IMDb id is cached.";
  return result;
}
