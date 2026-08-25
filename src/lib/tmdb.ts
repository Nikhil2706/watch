import "server-only";

import { env } from "./env";

/**
 * Thin client for TMDB's v3 API — used for two things: letting a curator
 * browse a movie's available poster art and pick a different one than
 * whatever Jellyfin's own scan settled on (getMoviePosters), and, for
 * parental-control filtering, checking a title's certifications across
 * every country TMDB has data for plus its content-descriptor keywords
 * (getContentSignal — see content-warnings.ts and parental-control.ts for
 * how that result actually gets used). Nothing else in this app reads from
 * TMDB; Jellyfin's own scan already pulls its metadata (title, overview,
 * the poster it starts with) directly, and ratings come from OMDb — this is
 * additive, not a replacement for either.
 */

const BASE_URL = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

export class TmdbError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

export function isTmdbConfigured(): boolean {
  return env.tmdbReadAccessToken !== "";
}

async function tmdbFetch<T>(path: string): Promise<T> {
  if (!env.tmdbReadAccessToken) {
    throw new TmdbError("TMDB_READ_ACCESS_TOKEN is not configured.", 0);
  }
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${env.tmdbReadAccessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (cause) {
    throw new TmdbError(`Could not reach TMDB: ${cause instanceof Error ? cause.message : String(cause)}`, 0);
  }
  if (!response.ok) {
    throw new TmdbError(`TMDB ${path} failed with ${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

interface FindResponse {
  movie_results: Array<{ id: number; title: string; release_date: string }>;
}

/** Resolves an IMDb id (e.g. "tt0111161") to TMDB's own movie id. */
export async function findTmdbMovieByImdbId(imdbId: string): Promise<number | null> {
  const id = imdbId.startsWith("tt") ? imdbId : `tt${imdbId}`;
  const data = await tmdbFetch<FindResponse>(`/find/${id}?external_source=imdb_id`);
  return data.movie_results[0]?.id ?? null;
}

interface ImagesResponse {
  posters: Array<{
    file_path: string;
    width: number;
    height: number;
    vote_average: number;
    iso_639_1: string | null;
  }>;
}

export interface TmdbPoster {
  /** Full-size, for actually setting as the item's image. */
  fullUrl: string;
  /** Small, for the picker grid. */
  thumbUrl: string;
  width: number;
  height: number;
  language: string | null;
  voteAverage: number;
}

/**
 * "18+"-equivalent certifications across the markets TMDB actually has
 * release-date/certification data for. Checking every country, not just the
 * US, is the whole point — most of this library's arthouse/foreign titles
 * never got an MPAA rating at all, but plenty DO have a French, German,
 * British or Italian one. Deliberately excludes teen-tier ratings (PG-13,
 * FSK 16, 15-rated) — the goal is catching adult content, not narrowing the
 * library to family viewing.
 */
const RESTRICTED_CERTIFICATIONS = new Set([
  "R", "NC-17", "NC17", "X", // US
  "18", "R18", "R18+", // GB / AU / JP
  "18A", // CA
  "FSK 18", // DE
  "VM18", // IT
  "X18+", // AU (older)
]);

/**
 * TMDB's community-tagged content keywords, filtered to the ones that
 * actually signal the kind of content this feature exists to catch. Matched
 * as a substring, case-insensitively, against TMDB's (fairly free-form)
 * keyword vocabulary — "female nudity", "rape scene" and "sexual violence"
 * all still match "nudity"/"rape"/"sexual violence" this way. Deliberately
 * not exhaustive: this is a best-effort additional signal on top of
 * certifications, not the only line of defense — see the honest limitation
 * noted where this is used (parental-control.ts).
 */
const RESTRICTED_KEYWORD_SUBSTRINGS = [
  "nudity", "sex scene", "explicit sex", "rape", "sexual assault", "sexual violence",
  "incest", "gore", "torture", "extreme violence", "graphic violence", "sadism",
  "pedophilia", "child abuse", "bestiality", "self harm", "suicide",
];

interface ReleaseDatesResponse {
  results: Array<{
    iso_3166_1: string;
    release_dates: Array<{ certification: string }>;
  }>;
}

interface KeywordsResponse {
  keywords: Array<{ id: number; name: string }>;
}

export interface ContentSignal {
  restricted: boolean;
  /** Whatever specific certification/keyword actually tripped it, for a curator to sanity-check. */
  signals: string[];
}

/**
 * The actual "does this need hiding from parental-control accounts" check —
 * every certification TMDB has for this title, across every country, plus
 * its content keywords. Two separate requests because TMDB has no combined
 * endpoint for both; run in parallel since neither depends on the other.
 */
export async function getContentSignal(tmdbId: number): Promise<ContentSignal> {
  const [releaseDates, keywords] = await Promise.all([
    tmdbFetch<ReleaseDatesResponse>(`/movie/${tmdbId}/release_dates`),
    tmdbFetch<KeywordsResponse>(`/movie/${tmdbId}/keywords`),
  ]);

  const signals: string[] = [];

  for (const country of releaseDates.results) {
    for (const release of country.release_dates) {
      const cert = release.certification.trim().toUpperCase();
      if (cert && RESTRICTED_CERTIFICATIONS.has(cert)) {
        signals.push(`${country.iso_3166_1}:${release.certification.trim()}`);
      }
    }
  }

  for (const keyword of keywords.keywords) {
    const lower = keyword.name.toLowerCase();
    const hit = RESTRICTED_KEYWORD_SUBSTRINGS.find((s) => lower.includes(s));
    if (hit) signals.push(`keyword:${keyword.name}`);
  }

  return { restricted: signals.length > 0, signals: [...new Set(signals)] };
}

/**
 * Every poster TMDB has for a title, best-rated first — sorted the same way
 * TMDB's own UI does, and the reason to pick from a list rather than just
 * taking the top one automatically: unlike a subtitle (right or wrong,
 * objectively), a poster is a matter of a curator's taste and language
 * preference.
 */
export async function getMoviePosters(tmdbId: number): Promise<TmdbPoster[]> {
  const data = await tmdbFetch<ImagesResponse>(`/movie/${tmdbId}/images`);
  return data.posters
    .slice()
    .sort((a, b) => b.vote_average - a.vote_average)
    .map((p) => ({
      fullUrl: `${IMAGE_BASE}/original${p.file_path}`,
      thumbUrl: `${IMAGE_BASE}/w342${p.file_path}`,
      width: p.width,
      height: p.height,
      language: p.iso_639_1,
      voteAverage: p.vote_average,
    }));
}
