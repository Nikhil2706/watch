import "server-only";

import { getCached, getLink } from "./tmdb-store";
import { CREW_JOBS, bucketForJob, type CrewBucket, type ShapedCredit } from "./tmdb-shape";
import { getGroupedPathMap } from "./library-curation";

/**
 * The projection layer: raw TMDB payload in, view models out.
 *
 * Phase 1 of the migration, and a prerequisite rather than a feature. Every
 * page that wants a cinematographer, a keyword chip or a trailer would
 * otherwise reach into a JSON blob itself, and there are 390 of those blobs
 * totalling 27 MB. Parsing them per request, per surface, is the shape of
 * problem that does not show up until the library is large and then shows up
 * everywhere at once.
 *
 * So: one place that knows the payload's shape, returning small typed objects
 * the rest of the app can hold. Nothing here fetches, nothing here writes.
 *
 * Everything is defensive about missing fields, because coverage is genuinely
 * partial and measured: recommendations 100%, cast 94%, backdrops 92%, keywords
 * 80%, logos 67%, tagline 57%, budget/revenue 46%, collection 10%. A surface
 * built on any of these has to render without it.
 */

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export interface CreditPerson {
  tmdbId: number;
  name: string;
  /** Character for cast; job for crew. */
  role: string;
  profileUrl: string | null;
  order: number;
}

export type FilmCrew = Record<CrewBucket, CreditPerson[]>;

export interface RelatedFilm {
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
  voteAverage: number;
}

export interface FilmView {
  tmdbId: number;
  imdbId: string | null;
  title: string;
  originalTitle: string | null;
  /** Only set when it differs from the title — otherwise there is nothing to say. */
  originalLanguage: string | null;
  tagline: string | null;
  overview: string | null;
  runtimeMinutes: number | null;
  releaseDate: string | null;
  genres: string[];
  keywords: string[];
  cast: CreditPerson[];
  crew: FilmCrew;
  recommendations: RelatedFilm[];
  similar: RelatedFilm[];
  collection: { tmdbId: number; name: string } | null;
  trailerUrl: string | null;
  logoUrl: string | null;
  backdropUrl: string | null;
  budget: number | null;
  revenue: number | null;
  voteAverage: number | null;
  /** Every title TMDB knows this by, for search and for match auditing. */
  alternativeTitles: Array<{ region: string; title: string }>;
}

/* ------------------------------------------------------------------ *
 * Raw payload, described only as much as is read
 * ------------------------------------------------------------------ */

interface RawPerson {
  id: number;
  name: string;
  character?: string;
  job?: string;
  profile_path?: string | null;
  order?: number;
}

interface RawRelated {
  id: number;
  title?: string;
  name?: string;
  release_date?: string | null;
  poster_path?: string | null;
  vote_average?: number;
}

interface RawImage {
  file_path: string;
  vote_average?: number;
  iso_639_1?: string | null;
}

interface RawMovie {
  id: number;
  imdb_id?: string | null;
  title?: string;
  original_title?: string;
  original_language?: string;
  tagline?: string;
  overview?: string;
  runtime?: number | null;
  release_date?: string | null;
  budget?: number;
  revenue?: number;
  vote_average?: number;
  genres?: Array<{ name: string }>;
  belongs_to_collection?: { id: number; name: string } | null;
  keywords?: { keywords?: Array<{ name: string }> };
  credits?: { cast?: RawPerson[]; crew?: RawPerson[] };
  recommendations?: { results?: RawRelated[] };
  similar?: { results?: RawRelated[] };
  videos?: { results?: Array<{ key: string; site: string; type: string; official?: boolean }> };
  images?: { logos?: RawImage[]; backdrops?: RawImage[] };
  alternative_titles?: { titles?: Array<{ iso_3166_1: string; title: string }> };
  external_ids?: { imdb_id?: string | null };
}

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

/**
 * A same-origin URL for a TMDB image, for anything a browser will load.
 *
 * NOT tmdbImage(), which returns image.tmdb.org and must keep doing so — the
 * episode-still applier and the console's artwork picker both need the real
 * upstream URL to fetch from. This is the browser-facing form: it goes through
 * /api/tmdb-image, which caches the bytes and keeps the promise every other
 * image on this site keeps, that the viewer's browser makes no third-party
 * request. Hotlinking would hand TMDB each viewer's IP and, via the Referer,
 * the film they are reading about.
 */
function proxied(path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  return `/api/tmdb-image?path=${encodeURIComponent(path)}&size=${encodeURIComponent(size)}`;
}

function person(p: RawPerson, roleField: "character" | "job"): CreditPerson {
  return {
    tmdbId: p.id,
    name: p.name,
    role: (roleField === "character" ? p.character : p.job) ?? "",
    profileUrl: proxied(p.profile_path ?? null, "w185"),
    order: p.order ?? 999,
  };
}

/**
 * Crew, bucketed by the jobs worth surfacing.
 *
 * TMDB returns everything — 1,102 stunt credits across this library — so a raw
 * crew list is unusable. These six are the ones a film page can name and a
 * browse facet can be built on. Deduplicated by person, because someone
 * credited twice for the same job (common on older films) should appear once.
 */
function bucketCrew(raw: RawPerson[]): FilmCrew {
  const out: FilmCrew = {
    directors: [],
    writers: [],
    cinematographers: [],
    composers: [],
    editors: [],
    productionDesigners: [],
  };

  for (const key of Object.keys(CREW_JOBS) as Array<keyof FilmCrew>) {
    const jobs = CREW_JOBS[key];
    const seen = new Set<number>();
    for (const c of raw) {
      if (!c.job || !jobs.includes(c.job)) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out[key].push(person(c, "job"));
    }
  }
  return out;
}

function related(list: RawRelated[] | undefined, limit: number): RelatedFilm[] {
  return (list ?? []).slice(0, limit).map((r) => ({
    tmdbId: r.id,
    title: r.title ?? r.name ?? "",
    year: r.release_date ? Number(r.release_date.slice(0, 4)) || null : null,
    posterUrl: proxied(r.poster_path ?? null, "w185"),
    voteAverage: r.vote_average ?? 0,
  }));
}

/**
 * The best trailer, or nothing.
 *
 * Official first, then anything labelled Trailer, then a teaser. YouTube only —
 * it is the only site TMDB carries in volume, and the only one worth embedding.
 */
function trailer(videos: RawMovie["videos"]): string | null {
  const all = (videos?.results ?? []).filter((v) => v.site === "YouTube");
  const pick =
    all.find((v) => v.type === "Trailer" && v.official) ??
    all.find((v) => v.type === "Trailer") ??
    all.find((v) => v.type === "Teaser");
  return pick ? `https://www.youtube.com/watch?v=${pick.key}` : null;
}

/** Highest-rated image of a kind. Logos prefer a textless or English one. */
function bestImage(list: RawImage[] | undefined, size: string): string | null {
  const sorted = (list ?? []).slice().sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
  return sorted.length ? proxied(sorted[0]!.file_path, size) : null;
}

export function projectFilm(payload: unknown, tmdbId: number): FilmView | null {
  const m = payload as RawMovie | null;
  if (!m || typeof m !== "object") return null;

  const title = m.title ?? "";
  const originalTitle = m.original_title ?? null;

  return {
    tmdbId,
    imdbId: m.imdb_id ?? m.external_ids?.imdb_id ?? null,
    title,
    // Only meaningful when it actually differs — "Ran" beside "乱" is worth
    // showing, "Memento" beside "Memento" is noise.
    originalTitle: originalTitle && originalTitle !== title ? originalTitle : null,
    originalLanguage: m.original_language ?? null,
    tagline: m.tagline?.trim() || null,
    overview: m.overview?.trim() || null,
    runtimeMinutes: m.runtime ?? null,
    releaseDate: m.release_date ?? null,
    genres: (m.genres ?? []).map((g) => g.name),
    keywords: (m.keywords?.keywords ?? []).map((k) => k.name),
    cast: (m.credits?.cast ?? [])
      .slice()
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .slice(0, 20)
      .map((c) => person(c, "character")),
    crew: bucketCrew(m.credits?.crew ?? []),
    recommendations: related(m.recommendations?.results, 12),
    similar: related(m.similar?.results, 12),
    collection: m.belongs_to_collection
      ? { tmdbId: m.belongs_to_collection.id, name: m.belongs_to_collection.name }
      : null,
    trailerUrl: trailer(m.videos),
    logoUrl: bestImage(m.images?.logos, "w500"),
    backdropUrl: bestImage(m.images?.backdrops, "w1280"),
    budget: m.budget && m.budget > 0 ? m.budget : null,
    revenue: m.revenue && m.revenue > 0 ? m.revenue : null,
    voteAverage: m.vote_average ?? null,
    alternativeTitles: (m.alternative_titles?.titles ?? []).map((t) => ({
      region: t.iso_3166_1,
      title: t.title,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

/** By TMDB id. Null when the film is not in the store. */
export function filmViewByTmdbId(tmdbId: number): FilmView | null {
  const cached = getCached("movie", tmdbId);
  return cached ? projectFilm(cached.payload, tmdbId) : null;
}

/**
 * By library path, which is how everything else here is keyed.
 *
 * Path rather than Jellyfin item id on purpose: item ids do not survive a
 * library rebuild and paths do, which is why the whole curation layer is
 * path-keyed.
 */
export function filmViewByPath(path: string | null | undefined): FilmView | null {
  if (!path) return null;
  const link = getLink("path", path);
  if (!link || link.tmdbKind !== "movie" || link.tmdbId <= 0) return null;
  return filmViewByTmdbId(link.tmdbId);
}

/* ------------------------------------------------------------------ *
 * Television
 *
 * The show page and the episode page were built before any of this existed
 * and show it: the show hero paints the 2:3 series poster into a wide box,
 * its cast and crew are two comma-separated text lines, and an episode is
 * titled with its filename stem. Everything needed to fix all three is
 * already in the cache — a show payload carries credits, images, networks and
 * run dates, and a season payload carries every episode's own crew and guest
 * stars. None of it costs a request.
 * ------------------------------------------------------------------ */

export interface ShowView {
  tmdbId: number;
  name: string;
  tagline: string | null;
  overview: string | null;
  /** "1999-2006", or "1999-" while it is still running. */
  years: string | null;
  /** TMDB's own word: Ended, Returning Series, Canceled. */
  status: string | null;
  seasonCount: number | null;
  episodeCount: number | null;
  networks: string[];
  creators: string[];
  genres: string[];
  cast: CreditPerson[];
  crew: FilmCrew;
  logoUrl: string | null;
  /** A real 16:9 backdrop, rather than the poster the hero stretches today. */
  backdropUrl: string | null;
  voteAverage: number | null;
}

interface RawShow {
  id: number;
  name?: string;
  tagline?: string;
  overview?: string;
  first_air_date?: string | null;
  last_air_date?: string | null;
  status?: string;
  in_production?: boolean;
  number_of_seasons?: number;
  number_of_episodes?: number;
  networks?: Array<{ name: string }>;
  created_by?: Array<{ name: string }>;
  genres?: Array<{ name: string }>;
  vote_average?: number;
  backdrop_path?: string | null;
  images?: { logos?: RawImage[]; backdrops?: RawImage[] };
  credits?: { cast?: RawPerson[]; crew?: RawPerson[] };
  aggregate_credits?: { cast?: RawPerson[]; crew?: RawPerson[] };
}

function airYears(first: string | null | undefined, last: string | null | undefined, running: boolean): string | null {
  const from = first ? first.slice(0, 4) : null;
  if (!from) return null;
  const to = last ? last.slice(0, 4) : null;
  if (running || !to) return `${from}–`;
  return to === from ? from : `${from}–${to}`;
}

export function projectShow(payload: unknown, tmdbId: number): ShowView | null {
  const s = payload as RawShow | null;
  if (!s || typeof s !== "object") return null;

  const credits = s.credits ?? s.aggregate_credits ?? {};
  return {
    tmdbId,
    name: s.name ?? "",
    tagline: s.tagline?.trim() || null,
    overview: s.overview?.trim() || null,
    years: airYears(s.first_air_date, s.last_air_date, s.in_production === true),
    status: s.status ?? null,
    seasonCount: s.number_of_seasons ?? null,
    episodeCount: s.number_of_episodes ?? null,
    networks: (s.networks ?? []).map((n) => n.name).filter(Boolean),
    creators: (s.created_by ?? []).map((c) => c.name).filter(Boolean),
    genres: (s.genres ?? []).map((g) => g.name),
    cast: (credits.cast ?? []).slice(0, 20).map((c) => person(c, "character")),
    crew: bucketCrew(credits.crew ?? []),
    logoUrl: bestImage(s.images?.logos, "w500"),
    // The show's own backdrop first; its images list second. Either is 16:9,
    // which the poster this page currently uses is not.
    backdropUrl: s.backdrop_path
      ? proxied(s.backdrop_path, "w1280")
      : bestImage(s.images?.backdrops, "w1280"),
    voteAverage: typeof s.vote_average === "number" ? s.vote_average : null,
  };
}

/** By library group id, which is how a show is keyed everywhere else here. */
export function showViewByGroup(groupId: string | null | undefined): ShowView | null {
  if (!groupId) return null;
  const link = getLink("group", groupId);
  if (!link || link.tmdbKind !== "tv" || link.tmdbId <= 0) return null;
  const cached = getCached("tv", link.tmdbId);
  return cached ? projectShow(cached.payload, link.tmdbId) : null;
}

export interface EpisodeView {
  seasonNumber: number;
  episodeNumber: number;
  /** The real title. Today the page is headed with the filename stem. */
  name: string;
  overview: string | null;
  airDate: string | null;
  runtimeMinutes: number | null;
  stillUrl: string | null;
  voteAverage: number | null;
  /** Who made THIS episode — which show-level credits cannot express. */
  crew: CreditPerson[];
  /** In this episode but not the show's regular cast. */
  guests: CreditPerson[];
  /**
   * The same people, shaped for mergeCredits, so the page can fold this
   * episode's own crew into the same Cast and Crew rows a film gets rather
   * than growing two more rails for television.
   */
  credits: ShapedCredit[];
}

interface RawEpisode {
  episode_number?: number;
  season_number?: number;
  name?: string;
  overview?: string;
  air_date?: string | null;
  runtime?: number | null;
  still_path?: string | null;
  vote_average?: number;
  crew?: RawPerson[];
  guest_stars?: RawPerson[];
}

/**
 * One episode, from the season payload already on disk.
 *
 * Only the jobs worth naming survive from the episode's crew — a season
 * payload lists consulting producers and co-producers by the handful, and on a
 * card they say nothing about who made it.
 */
/**
 * Which TMDB episode a file is, which takes three reads rather than one.
 *
 * The obvious guess — that a path link carries the season and episode — is
 * wrong, and quietly so: a path link is `movie` with both fields null, because
 * every episode is a Movie item in this library. The position is recorded on
 * the `still` link written when the artwork was applied, and that row carries
 * `tmdb_id = 0` because it identifies a file rather than a show. The show's id
 * only exists on the group link. So: still link for the position, the grouped
 * path map for which show, and the group link for its TMDB id.
 *
 * Returns null for the ~60 files with no still link (19 unparsed names, 3
 * numbering mismatches, 39 episodes TMDB has no still for), which correctly
 * fall back to the filename-parsed label.
 */
function episodeLocator(path: string): { tmdbId: number; season: number; episode: number } | null {
  const still = getLink("still", path);
  if (!still || still.season === null || still.episode === null) return null;

  const group = getGroupedPathMap().get(path);
  if (!group) return null;

  const showLink = getLink("group", group.groupId);
  if (!showLink || showLink.tmdbKind !== "tv" || showLink.tmdbId <= 0) return null;

  return { tmdbId: showLink.tmdbId, season: still.season, episode: still.episode };
}

export function episodeViewByPath(path: string | null | undefined): EpisodeView | null {
  if (!path) return null;
  const link = episodeLocator(path);
  if (!link) return null;

  const cached = getCached<{ episodes?: RawEpisode[] }>("season", link.tmdbId, link.season);
  if (!cached) return null;

  const raw = (cached.payload.episodes ?? []).find((e) => e.episode_number === link.episode);
  if (!raw) return null;

  const named = new Set<string>();
  for (const jobs of Object.values(CREW_JOBS)) for (const job of jobs) named.add(job);

  return {
    seasonNumber: link.season,
    episodeNumber: link.episode,
    name: raw.name ?? "",
    overview: raw.overview?.trim() || null,
    airDate: raw.air_date ?? null,
    runtimeMinutes: raw.runtime ?? null,
    stillUrl: proxied(raw.still_path ?? null, "w780"),
    voteAverage: typeof raw.vote_average === "number" ? raw.vote_average : null,
    crew: (raw.crew ?? []).filter((c) => c.job && named.has(c.job)).map((c) => person(c, "job")),
    guests: (raw.guest_stars ?? []).slice(0, 8).map((c) => person(c, "character")),
    credits: [
      ...(raw.crew ?? []).flatMap((c): ShapedCredit[] => {
        const bucket = c.job ? bucketForJob(c.job) : null;
        if (!bucket) return [];
        return [
          {
            tmdbId: c.id,
            name: c.name,
            profilePath: c.profile_path ?? null,
            department: bucket,
            job: c.job as string,
            ord: 0,
          },
        ];
      }),
      ...(raw.guest_stars ?? []).slice(0, 8).map(
        (c, i): ShapedCredit => ({
          tmdbId: c.id,
          name: c.name,
          profilePath: c.profile_path ?? null,
          department: "cast",
          // Said on the card, because a guest is a different fact from a
          // series regular and the row would otherwise flatten the two.
          job: c.character ? `Guest · ${c.character}` : "Guest",
          ord: 100 + i,
        }),
      ),
    ],
  };
}

/** The bit of an episode a tile in a season row can show. */
export interface EpisodeTile {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  airDate: string | null;
  voteAverage: number | null;
}

/**
 * Episode titles for a whole row at once.
 *
 * The film page learned an episode's real name; the season row a viewer
 * actually browses from did not, and still labelled every tile with the
 * filename stem it parsed. This closes that, in one pass over the season
 * payloads rather than one lookup per tile.
 */
export function episodeTilesForPaths(paths: string[]): Map<string, EpisodeTile> {
  const out = new Map<string, EpisodeTile>();
  if (paths.length === 0) return out;

  // One cached season payload serves every episode of that season, so read
  // each at most once however many tiles are asking.
  const seasons = new Map<string, RawEpisode[]>();
  const seasonFor = (tmdbId: number, season: number): RawEpisode[] => {
    const key = `${tmdbId}:${season}`;
    const hit = seasons.get(key);
    if (hit) return hit;
    const cached = getCached<{ episodes?: RawEpisode[] }>("season", tmdbId, season);
    const episodes = cached?.payload.episodes ?? [];
    seasons.set(key, episodes);
    return episodes;
  };

  for (const path of paths) {
    const link = episodeLocator(path);
    if (!link) continue;
    const raw = seasonFor(link.tmdbId, link.season).find(
      (e) => e.episode_number === link.episode,
    );
    if (!raw?.name) continue;
    out.set(path, {
      seasonNumber: link.season,
      episodeNumber: link.episode,
      name: raw.name,
      airDate: raw.air_date ?? null,
      voteAverage: typeof raw.vote_average === "number" ? raw.vote_average : null,
    });
  }
  return out;
}

export interface SeasonView {
  seasonNumber: number;
  name: string;
  overview: string | null;
  posterUrl: string | null;
  episodeCount: number | null;
  airYear: string | null;
}

interface RawSeasonSummary {
  season_number?: number;
  name?: string;
  overview?: string;
  poster_path?: string | null;
  episode_count?: number;
  air_date?: string | null;
}

/**
 * What TMDB knows about each season of a show, keyed by season number.
 *
 * From the show payload's own seasons array rather than the per-season
 * payloads: it carries the poster, the overview and the true episode count
 * without needing a season to have been fetched at all.
 */
export interface DirectedFilm {
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

export interface PersonView {
  tmdbId: number;
  name: string;
  biography: string | null;
  /** ISO dates, as TMDB gives them. */
  born: string | null;
  died: string | null;
  birthplace: string | null;
  /** TMDB's own word for it: "Directing", "Acting", "Camera". */
  knownFor: string | null;
  profileUrl: string | null;
  /** Films they directed, released ones only, earliest first. */
  directed: DirectedFilm[];
}

interface RawPersonPayload {
  name?: string;
  biography?: string;
  birthday?: string | null;
  deathday?: string | null;
  place_of_birth?: string | null;
  known_for_department?: string | null;
  profile_path?: string | null;
  movie_credits?: {
    crew?: Array<{
      id: number;
      title?: string;
      job?: string;
      release_date?: string | null;
      poster_path?: string | null;
    }>;
  };
}

export function projectPerson(payload: unknown, tmdbId: number): PersonView | null {
  const p = payload as RawPersonPayload | null;
  if (!p || typeof p !== "object") return null;

  // Directed, once each (TMDB lists a film twice when someone holds the credit
  // twice, which is common on older co-directed work), and released ones only:
  // an announced film with no date is not one anybody can own yet.
  const seen = new Set<number>();
  const directed: DirectedFilm[] = [];
  for (const c of p.movie_credits?.crew ?? []) {
    if (c.job !== "Director" || !c.release_date || seen.has(c.id)) continue;
    seen.add(c.id);
    directed.push({
      tmdbId: c.id,
      title: c.title ?? "",
      year: Number(c.release_date.slice(0, 4)) || null,
      posterUrl: proxied(c.poster_path ?? null, "w185"),
    });
  }
  directed.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));

  return {
    tmdbId,
    name: p.name ?? "",
    biography: p.biography?.trim() || null,
    born: p.birthday ?? null,
    died: p.deathday ?? null,
    birthplace: p.place_of_birth?.trim() || null,
    knownFor: p.known_for_department ?? null,
    profileUrl: proxied(p.profile_path ?? null, "h632"),
    directed,
  };
}

/** From the cache only. tmdb-person.ts is what puts it there. */
export function personViewByTmdbId(tmdbId: number): PersonView | null {
  const cached = getCached("person", tmdbId);
  return cached ? projectPerson(cached.payload, tmdbId) : null;
}

export function seasonViewsByGroup(groupId: string | null | undefined): Map<number, SeasonView> {
  const out = new Map<number, SeasonView>();
  if (!groupId) return out;
  const link = getLink("group", groupId);
  if (!link || link.tmdbKind !== "tv" || link.tmdbId <= 0) return out;

  const cached = getCached<{ seasons?: RawSeasonSummary[] }>("tv", link.tmdbId);
  for (const s of cached?.payload.seasons ?? []) {
    if (typeof s.season_number !== "number") continue;
    out.set(s.season_number, {
      seasonNumber: s.season_number,
      name: s.name ?? `Season ${s.season_number}`,
      overview: s.overview?.trim() || null,
      posterUrl: proxied(s.poster_path ?? null, "w342"),
      episodeCount: s.episode_count ?? null,
      airYear: s.air_date ? s.air_date.slice(0, 4) : null,
    });
  }
  return out;
}
