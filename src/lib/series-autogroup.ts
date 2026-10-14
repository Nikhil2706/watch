import "server-only";

import { getAdminMovies, invalidateAdminMovies } from "./admin-library-cache";
import { asRows, getDb } from "./db";
import { env } from "./env";
import { getAlternateVersionPathSet } from "./film-versions";
import { getLibraryScanStatus, type AdminMovieListItem } from "./jellyfin";
import {
  addToGroup,
  createGroup,
  declineSubject,
  getExcludedPathSet,
  getGroupOverview,
  listGroups,
  markAutoGroup,
  setGroupKind,
  setGroupOverview,
  setGroupSeriesId,
  setGroupSeriesMeta,
  setGroupSeriesPoster,
} from "./library-curation";
import { fetchOmdbSeries, type OmdbSeries } from "./omdb-episodes";
import { reconcileGroupSlots } from "./rollout";
import {
  detectSeries,
  planGrouping,
  type EpisodeFile,
  type GroupingState,
  type GroupingStep,
  type SeriesCluster,
} from "./series-detect";
import { getSpecialFeatureIdSet } from "./special-features";
import { fetchShow, getCached, putLink } from "./tmdb-store";

/**
 * Grouping episodes into their show without being asked.
 *
 * series-detect.ts decides which files are one series and what to do about
 * each; this reads the library and the database for it, asks OMDb or TMDB
 * what the series is called (once per series, remembered in series_names),
 * and writes the groups. Runs after the nightly folder_match job and after a
 * library scan has finished.
 *
 * What the curator has done by hand stands: a group they made is added to,
 * never changed; a group they dissolved is not made again (its files and its
 * series are recorded in library_group_declined when it is dissolved, see
 * library-curation.ts); a file they took out of a group stays out.
 */

/* ------------------------------------------------------------------ *
 * What the library says
 * ------------------------------------------------------------------ */

function omdbKinds(): Map<string, { type: string; seriesImdbId: string | null }> {
  return new Map(
    asRows<{ imdb_id: string; type: string; series_imdb_id: string | null }>(
      getDb().prepare("SELECT imdb_id, type, series_imdb_id FROM omdb_title_kind").all(),
    ).map((r) => [r.imdb_id, { type: r.type, seriesImdbId: r.series_imdb_id }]),
  );
}

function tmdbEpisodeLinks(): Map<string, number> {
  return new Map(
    asRows<{ subject_id: string; tmdb_id: number }>(
      getDb()
        .prepare("SELECT subject_id, tmdb_id FROM tmdb_links WHERE subject_type = 'path' AND tmdb_kind = 'tv'")
        .all(),
    ).map((r) => [r.subject_id, r.tmdb_id]),
  );
}

/** Every file that could be an episode: not hidden, not a special feature, not a second cut of a film. */
async function libraryFiles(listing?: AdminMovieListItem[]): Promise<EpisodeFile[]> {
  const all = listing ?? (await getAdminMovies({ withMediaSources: false }));
  const excluded = getExcludedPathSet();
  const features = getSpecialFeatureIdSet();
  const alternates = getAlternateVersionPathSet();
  const kinds = omdbKinds();
  const tmdb = tmdbEpisodeLinks();
  return all
    .filter((m) => !!m.Path && !excluded.has(m.Path) && !features.has(m.Id) && !alternates.has(m.Path))
    .map((m) => {
      const imdb = m.ProviderIds?.Imdb;
      return { path: m.Path!, omdb: (imdb && kinds.get(imdb)) || null, tmdbTvId: tmdb.get(m.Path!) ?? null };
    });
}

function declined(): { keys: Set<string>; paths: Set<string> } {
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const r of asRows<{ subject: string }>(getDb().prepare("SELECT subject FROM library_group_declined").all())) {
    if (r.subject.startsWith("path:")) paths.add(r.subject.slice("path:".length));
    else keys.add(r.subject);
  }
  return { keys, paths };
}

function storedNames(): Map<string, string> {
  return new Map(
    asRows<{ series_key: string; name: string }>(getDb().prepare("SELECT series_key, name FROM series_names").all()).map(
      (r) => [r.series_key, r.name],
    ),
  );
}

function groupingState(): GroupingState {
  const db = getDb();
  const seriesIds = new Map(
    asRows<{ group_id: string; imdb_id: string }>(db.prepare("SELECT group_id, imdb_id FROM library_group_series").all()).map(
      (r) => [r.group_id, r.imdb_id],
    ),
  );
  const tmdbIds = new Map(
    asRows<{ subject_id: string; tmdb_id: number }>(
      db.prepare("SELECT subject_id, tmdb_id FROM tmdb_links WHERE subject_type = 'group' AND tmdb_kind = 'tv'").all(),
    ).map((r) => [r.subject_id, r.tmdb_id]),
  );
  const groups = listGroups();
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const p of g.paths) groupOf.set(p, g.groupId);
  const { keys, paths } = declined();
  return {
    groupOf,
    groups: groups.map((g) => ({
      groupId: g.groupId,
      name: g.groupName,
      seriesImdbId: seriesIds.get(g.groupId) ?? null,
      tmdbTvId: tmdbIds.get(g.groupId) ?? null,
    })),
    declinedKeys: keys,
    declinedPaths: paths,
    names: storedNames(),
  };
}

/** Every series and what would be done about it now, without changing anything. */
export async function planSeriesGrouping(listing?: AdminMovieListItem[]): Promise<GroupingStep[]> {
  const clusters = detectSeries(await libraryFiles(listing), env.mediaLibraryPath);
  return planGrouping(clusters, groupingState());
}

/* ------------------------------------------------------------------ *
 * Names, from OMDb or TMDB, once per series
 * ------------------------------------------------------------------ */

function rememberName(key: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO series_names (series_key, name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(series_key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    )
    .run(key, name, Date.now());
}

interface SeriesFacts {
  name: string | null;
  /** The series' own IMDb id, from OMDb's episode record or TMDB's show. */
  imdbId: string | null;
  omdb: OmdbSeries | null;
}

/**
 * What the series is called and its IMDb id. TMDB first when there is a TMDB
 * id (no daily cap, and usually cached already); OMDb only for a series it is
 * the sole source for, and only when asked to (`omdb`), since that call comes
 * out of the 1,000 a day.
 */
async function seriesFacts(cluster: SeriesCluster, options: { omdb: boolean }): Promise<SeriesFacts> {
  let name: string | null = null;
  let imdbId = cluster.seriesImdbId;
  if (cluster.tmdbTvId !== null) {
    const show =
      getCached<{ name?: string; external_ids?: { imdb_id?: string } }>("tv", cluster.tmdbTvId) ??
      (await fetchShow(cluster.tmdbTvId).catch(() => null));
    const payload = show?.payload as { name?: string; external_ids?: { imdb_id?: string } } | undefined;
    name = payload?.name?.trim() || null;
    imdbId = imdbId ?? payload?.external_ids?.imdb_id ?? null;
  }
  let omdb: OmdbSeries | null = null;
  if (imdbId && options.omdb) {
    omdb = await fetchOmdbSeries(imdbId).catch(() => null);
    name = name ?? omdb?.name?.trim() ?? null;
  }
  if (name) rememberName(cluster.key, name);
  return { name, imdbId, omdb };
}

/** The same series link a curator makes with "Series IMDb link" in Show settings — see the group-series route. */
export function applyOmdbSeries(groupId: string, imdbId: string, series: OmdbSeries | null): void {
  setGroupSeriesId(groupId, imdbId);
  // Only ever set from OMDb here, never cleared: a curator who has already
  // corrected this group by hand (a long film OMDb calls a mini-series)
  // shouldn't have that undone by someone re-linking the same series.
  if (series?.kind) setGroupKind(groupId, series.kind);
  if (series?.posterUrl) setGroupSeriesPoster(groupId, series.posterUrl);
  if (series?.overview && !getGroupOverview(groupId)) setGroupOverview(groupId, series.overview);
  if (series) {
    setGroupSeriesMeta(groupId, {
      genres: series.genres,
      actors: series.actors,
      director: series.director,
      writer: series.writer,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Doing it
 * ------------------------------------------------------------------ */

async function createSeriesGroup(step: Extract<GroupingStep, { action: "create" }>): Promise<{ groupId: string; name: string }> {
  // The stored name is used when there is one; a series not asked about yet
  // is asked now, the one time it matters.
  const known = storedNames().get(step.key);
  const facts = await seriesFacts(step.cluster, { omdb: true });
  const name = known ?? facts.name ?? step.name;

  // createGroup is its own transaction (and they do not nest); the marker row
  // follows it. A crash between the two leaves a group that reads as made by
  // hand, which is the safe way round: it is only ever added to either way.
  const groupId = createGroup(name, step.paths);
  markAutoGroup(groupId, step.key);
  if (facts.imdbId) applyOmdbSeries(groupId, facts.imdbId, facts.omdb);
  if (step.cluster.tmdbTvId !== null) {
    putLink({
      subjectType: "group",
      subjectId: groupId,
      tmdbKind: "tv",
      tmdbId: step.cluster.tmdbTvId,
      season: null,
      episode: null,
      resolvedBy: "auto-group",
    });
  }
  reconcileGroupSlots(groupId);
  return { groupId, name };
}

function addToSeriesGroup(step: Extract<GroupingStep, { action: "add" }>): number {
  const added = addToGroup(step.groupId, step.paths);
  // A show with a rollout plan gets slots for its new episodes (rollout.ts).
  if (added > 0) reconcileGroupSlots(step.groupId);
  return added;
}

export interface SeriesAutoGroupRun {
  created: Array<{ name: string; files: number }>;
  added: Array<{ name: string; files: number }>;
  /** Ungrouped episodes left for the curator: one-file series, dissolved series, ambiguous ones. */
  waiting: number;
}

const g = globalThis as { __seriesAutoGroupRunning?: Promise<SeriesAutoGroupRun> | null };

/** One pass at a time; a second caller gets the result of the one already running. */
export function runSeriesAutoGroup(): Promise<SeriesAutoGroupRun> {
  if (g.__seriesAutoGroupRunning) return g.__seriesAutoGroupRunning;
  const run = pass().finally(() => {
    g.__seriesAutoGroupRunning = null;
  });
  g.__seriesAutoGroupRunning = run;
  return run;
}

async function pass(): Promise<SeriesAutoGroupRun> {
  const steps = await planSeriesGrouping();
  const result: SeriesAutoGroupRun = { created: [], added: [], waiting: 0 };
  for (const step of steps) {
    try {
      if (step.action === "create") {
        const made = await createSeriesGroup(step);
        result.created.push({ name: made.name, files: step.paths.length });
      } else if (step.action === "add") {
        const n = addToSeriesGroup(step);
        if (n > 0) result.added.push({ name: step.groupName, files: n });
      } else {
        result.waiting += step.paths.length;
        // So the console can say what it would be grouped as. TMDB only:
        // OMDb's daily allowance is not spent on a series nobody has grouped.
        if (!storedNames().has(step.key)) await seriesFacts(step.cluster, { omdb: false });
      }
    } catch (error) {
      console.error(`[series-autogroup] ${step.key}:`, error);
    }
  }
  if (result.created.length > 0 || result.added.length > 0) invalidateAdminMovies();
  return result;
}

/** One line for the job history. */
export function describeAutoGroupRun(r: SeriesAutoGroupRun): string {
  const parts: string[] = [];
  if (r.created.length) parts.push(`grouped ${r.created.map((c) => `${c.name} (${c.files})`).join(", ")}`);
  if (r.added.length) parts.push(`added to ${r.added.map((a) => `${a.name} (${a.files})`).join(", ")}`);
  if (r.waiting) parts.push(`${r.waiting} episode${r.waiting === 1 ? "" : "s"} left for you`);
  return parts.length ? parts.join("; ") : "no ungrouped episodes";
}

/**
 * After a library scan: wait for Jellyfin to finish (the scan call returns as
 * soon as it starts), then group what arrived. Fire-and-forget from
 * library-scan.ts; gives up waiting after half an hour and runs anyway.
 */
export async function autoGroupAfterScan(): Promise<void> {
  const deadline = Date.now() + 30 * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  while (Date.now() < deadline) {
    const status = await getLibraryScanStatus().catch(() => null);
    if (!status?.running) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  invalidateAdminMovies();
  const r = await runSeriesAutoGroup();
  if (r.created.length || r.added.length) console.log(`[series-autogroup] after scan: ${describeAutoGroupRun(r)}`);
}

/* ------------------------------------------------------------------ *
 * The console
 * ------------------------------------------------------------------ */

export interface PendingSeries {
  key: string;
  /** What "Group as ..." would call it, or the group it would join. */
  name: string;
  /** Set when the files would join an existing group rather than make one. */
  groupId: string | null;
  paths: string[];
}

/**
 * Every recognised episode in no group, by series — what "Needs you" lists.
 * Pass the listing when the caller already has it (library-review.ts).
 */
export async function listPendingSeries(listing?: AdminMovieListItem[]): Promise<PendingSeries[]> {
  const steps = await planSeriesGrouping(listing);
  return steps.map((s) => ({
    key: s.key,
    name: s.action === "add" ? s.groupName : s.name,
    groupId: s.action === "add" ? s.groupId : null,
    paths: s.paths,
  }));
}

/**
 * The console's "Group as <series>": groups every loose file of that series
 * now, whatever the nightly pass would have done. The curator asking
 * overrides an earlier "keep these apart" for the files and the series.
 */
export async function groupSeriesNow(key: string): Promise<{ groupId: string; name: string; files: number }> {
  const files = await libraryFiles();
  const cluster = detectSeries(files, env.mediaLibraryPath).find((c) => c.key === key);
  if (!cluster) throw new Error("Those episodes are no longer in the library.");

  const state = groupingState();
  // Clear the declines this click overrides, then plan as if never declined.
  const db = getDb();
  db.prepare("DELETE FROM library_group_declined WHERE subject = ?").run(key);
  for (const p of cluster.paths) {
    if (!state.groupOf.has(p)) db.prepare("DELETE FROM library_group_declined WHERE subject = ?").run(`path:${p}`);
  }
  const fresh = { ...state, declinedKeys: new Set<string>(), declinedPaths: new Set<string>() };
  const [step] = planGrouping([cluster], fresh);
  if (!step) throw new Error("Every episode of that series is already in a show.");

  let result: { groupId: string; name: string; files: number };
  if (step.action === "add") {
    result = { groupId: step.groupId, name: step.groupName, files: addToSeriesGroup(step) };
  } else if (step.action === "wait" && step.why === "ambiguous") {
    throw new Error("Some episodes of this series are already in two different shows. Add these by hand.");
  } else {
    // A single file, or a series dissolved before: the curator has asked, so make it.
    const made = await createSeriesGroup({ action: "create", key: step.key, name: step.name, paths: step.paths, cluster });
    result = { ...made, files: step.paths.length };
  }
  invalidateAdminMovies();
  return result;
}

/** "Keep as a film": this file is not an episode, or the curator wants it shown on its own. */
export function keepAsFilm(path: string): void {
  declineSubject(`path:${path}`, null);
}
