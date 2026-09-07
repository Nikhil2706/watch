import "server-only";

import { buildBrowseData, basePopularity } from "./browse-data";
import { getDb, asRows } from "./db";
import { getList } from "./lists";
import { getResume } from "./media";
import {
  applyColdStart,
  buildTasteProfile,
  pickSlate,
  scoreCandidates,
  type PickCandidate,
  type PickMode,
  type ScoredPick,
  type TasteSignals,
} from "./picker";
import type { ResolvedSession } from "./session";

/**
 * Assembles the signals "choose something for me" reasons from, and nothing else.
 *
 * ------------------------------------------------------------------------
 * The candidate pool comes from buildBrowseData() and MUST keep coming from
 * buildBrowseData(). It is the call that has already applied filterVisible():
 * exclusions, thin metadata, scheduled rollout, special features and parental
 * control. Everything filterVisible() hides is hidden for a reason a viewer
 * must not be able to route around, and a rollout-hidden title surfacing
 * through a shuffle button is a leak of unreleased content, not a cosmetic
 * bug. If anyone later "optimises" this by calling fetchAllMoviesCached()
 * directly, that is exactly what happens.
 * ------------------------------------------------------------------------
 *
 * Reads only the viewer's own data, through the viewer's own session, computes
 * on demand, and writes nothing — no history table, no offer log, no taste
 * profile cached to disk. Those three properties are what keep this feature
 * clear of the viewing-metrics work that was deliberately parked; see the
 * privacy section of DESIGN-choose-for-me.md before changing any of them.
 */

/** Started past this and left alone counts as abandonment rather than a pause. */
const ABANDON_MIN_TICKS = 5 * 60 * 1000 * 10_000; // 5 minutes in Jellyfin ticks
const ABANDON_MAX_PROGRESS = 0.2;

/**
 * How many of the curator's own articles mention each film, keyed by IMDb id.
 *
 * 330 distinct films are written about in this library. With almost no ratings
 * or list entries on the box, this is the signal that does the real work — see
 * the note at the top of picker.ts.
 */
function articleCountsByImdb(): Map<string, number> {
  const rows = asRows<{ imdb_id: string; n: number }>(
    getDb()
      .prepare(
        `SELECT imdb_id, COUNT(*) AS n
           FROM article_film_links
          WHERE imdb_id IS NOT NULL AND imdb_id <> ''
          GROUP BY imdb_id`,
      )
      .all(),
  );
  return new Map(rows.map((r) => [r.imdb_id, r.n]));
}

/** The viewer's own star ratings, keyed by IMDb id — that is how they are stored. */
function ratingsByImdb(userId: string): Map<string, number> {
  const rows = asRows<{ imdb_id: string; score: number }>(
    getDb().prepare("SELECT imdb_id, score FROM user_ratings WHERE user_id = ?").all(userId),
  );
  return new Map(rows.map((r) => [r.imdb_id, r.score]));
}

export interface PickRequest {
  mode: PickMode;
  seed: number;
  exclude?: ReadonlySet<string>;
  /** Runtime ceiling in minutes, when the viewer asked for something short. */
  maxMinutes?: number;
  genre?: string;
  size?: number;
}

export interface PickResult {
  picks: Array<{
    id: string;
    title: string;
    year: number | null;
    href: string;
    poster: string | null;
    reason: string;
    isGroup: boolean;
    runtimeMinutes: number | null;
  }>;
  mode: PickMode;
  /** True when there was no taste signal to work from — the UI says so plainly. */
  coldStart: boolean;
  /** How many candidates were in the pool, for the "nothing matches" state. */
  poolSize: number;
}

export async function buildPick(session: ResolvedSession, request: PickRequest): Promise<PickResult> {
  const { catalogue } = await buildBrowseData(session);
  const articles = articleCountsByImdb();
  const ratings = ratingsByImdb(session.userId);

  const candidates: PickCandidate[] = catalogue.movies.map((m) => {
    const imdb = m.item.ProviderIds?.Imdb;
    return {
      id: m.item.Id,
      title: m.item.Name,
      year: m.year,
      genres: m.genres,
      directors: m.directors,
      actors: m.actors,
      popularity: basePopularity(m, catalogue.libraryMeanRating),
      seen: m.seen,
      href: m.href,
      isGroup: m.isGroup,
      articleCount: (imdb && articles.get(imdb)) || 0,
      progress: progressOf(m.item.UserData),
      runtimeTicks: m.item.RunTimeTicks ?? null,
    };
  });

  // Ratings are stored against IMDb ids and everything else here is keyed on
  // item id, so translate once rather than at every lookup.
  const ratingsByItem = new Map<string, number>();
  for (const m of catalogue.movies) {
    const imdb = m.item.ProviderIds?.Imdb;
    const score = imdb ? ratings.get(imdb) : undefined;
    if (score !== undefined) ratingsByItem.set(m.item.Id, score);
  }

  const signals: TasteSignals = {
    likedIds: new Set([...getList(session.userId, "favourite"), ...getList(session.userId, "rewatch")]),
    ratings: ratingsByItem,
    playedIds: new Set(catalogue.movies.filter((m) => m.seen).map((m) => m.item.Id)),
    abandonedIds: new Set(
      catalogue.movies
        .filter((m) => {
          const ud = m.item.UserData;
          const pos = ud?.PlaybackPositionTicks ?? 0;
          const pct = progressOf(ud);
          return !m.seen && pos > ABANDON_MIN_TICKS && pct != null && pct < ABANDON_MAX_PROGRESS;
        })
        .map((m) => m.item.Id),
    ),
  };

  const profile = buildTasteProfile(candidates, signals);
  const pool = await poolFor(session, candidates, request, signals);
  const scored = scoreCandidates(pool, profile);
  const slate = applyColdStart(
    pickSlate(scored, {
      seed: request.seed,
      size: request.size ?? 10,
      exclude: request.exclude,
      // Pure random is an honest dice roll, not a gently-weighted one.
      temperature: request.mode === "random" ? 1000 : 0.6,
    }),
    profile,
  );

  const posters = new Map(catalogue.movies.map((m) => [m.item.Id, m.poster ?? null]));

  return {
    picks: slate.map((s) => toPick(s, posters)),
    mode: request.mode,
    coldStart: profile.isCold,
    poolSize: pool.length,
  };
}

function progressOf(ud: { PlayedPercentage?: number; PlaybackPositionTicks?: number } | undefined): number | undefined {
  if (!ud) return undefined;
  if (typeof ud.PlayedPercentage === "number") return ud.PlayedPercentage / 100;
  return undefined;
}

function toPick(
  s: ScoredPick,
  posters: Map<string, string | null>,
): PickResult["picks"][number] {
  const ticks = s.candidate.runtimeTicks ?? null;
  return {
    id: s.candidate.id,
    title: s.candidate.title,
    year: s.candidate.year,
    // A group tile has no Jellyfin item behind it, so its href already points at
    // /collection/{id}. Landing there rather than auto-selecting an episode is
    // deliberate: it sidesteps both the "picked part 2 of Fanny and Alexander"
    // bug and the case where the next episode is itself rollout-hidden.
    href: s.candidate.href,
    poster: posters.get(s.candidate.id) ?? null,
    reason: s.reason,
    isGroup: s.candidate.isGroup,
    runtimeMinutes: ticks == null ? null : Math.round(ticks / 10_000 / 1000 / 60),
  };
}

async function poolFor(
  session: ResolvedSession,
  candidates: PickCandidate[],
  request: PickRequest,
  signals: TasteSignals,
): Promise<PickCandidate[]> {
  let pool = candidates;

  if (request.mode === "finish") {
    // getResume() is the authority on what is half-watched; intersect rather
    // than re-deriving it, so the row and the button always agree.
    const resume = await getResume(session).catch(() => []);
    const ids = new Set(resume.map((i) => i.Id));
    pool = candidates.filter((c) => ids.has(c.id));
  } else if (request.mode === "again") {
    const rewatch = new Set(getList(session.userId, "rewatch"));
    const seenAndLiked = candidates.filter((c) => rewatch.has(c.id) || (c.seen && signals.ratings.get(c.id) !== undefined && signals.ratings.get(c.id)! >= 7));
    pool = seenAndLiked.length > 0 ? seenAndLiked : candidates.filter((c) => c.seen);
  } else if (request.mode === "new") {
    const rewatch = new Set(getList(session.userId, "rewatch"));
    pool = candidates.filter((c) => !c.seen || rewatch.has(c.id));
  }
  // "random" keeps the whole visible library, which is the point of it.

  if (request.genre) {
    const g = request.genre.toLowerCase();
    pool = pool.filter((c) => c.genres.some((x) => x.toLowerCase() === g));
  }

  if (request.maxMinutes) {
    const maxTicks = request.maxMinutes * 60 * 1000 * 10_000;
    // An unknown runtime is kept rather than dropped: excluding everything the
    // library has no duration for would quietly empty the pool.
    pool = pool.filter((c) => c.runtimeTicks == null || c.runtimeTicks <= maxTicks);
  }

  return pool;
}
