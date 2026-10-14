import { posix } from "node:path";

/**
 * Which files are episodes of the same series.
 *
 * Jellyfin has no idea a file is an episode: everything in this library is a
 * "Movie" to it, matched one file at a time. "Nirvanna the Band the Show" sat
 * on the site as sixteen separate films, each with its own episode poster and
 * title, until it was grouped by hand. This is what notices, so the grouping
 * can be done for it (series-autogroup.ts) and, until it is, the episodes are
 * kept out of discovery rather than shown as films (media.ts).
 *
 * The evidence, strongest first:
 *  - OMDb says the file's IMDb id is an episode, and of which series
 *    (Type "episode", seriesID). Recorded alongside the ratings fetch.
 *  - TMDB has the file linked to an episode of a show (tmdb_links, tv, with
 *    a season and episode).
 *  - The filename carries an SxxEyy (or 3x07) marker.
 *  - The folder: files with a marker sitting in the same show folder are the
 *    same show, which is how "NtBtS.S02E01" joins season one.
 *
 * Metadata wins over the filename. Two files OMDb puts in different series
 * are never joined because they share a folder or a prefix, and a file with
 * only a filename marker joins a metadata-identified series only when the
 * folder or the name leaves no doubt which one.
 *
 * Pure — no database, no network — so the rules are tested directly
 * (series-detect.test.ts).
 */

export interface EpisodeFile {
  path: string;
  /** What OMDb said this file's IMDb id is, when that is known. */
  omdb: { type: string; seriesImdbId: string | null } | null;
  /** The TMDB show this file is linked to as an episode, when it is. */
  tmdbTvId: number | null;
}

export type SeriesEvidence = "omdb" | "tmdb" | "filename";

export interface SeriesCluster {
  /** Stable across runs: "imdb:tt0123", "tmdb:456", or "file:<show folder>|<name>". */
  key: string;
  seriesImdbId: string | null;
  tmdbTvId: number | null;
  /** The strongest evidence any member has. */
  evidence: SeriesEvidence;
  paths: string[];
  /** The show folder's name, when every file in that folder belongs to this series. */
  folderName: string | null;
  /** The name the filenames give before their markers ("NtBtS"), tidied. */
  filenameName: string | null;
}

/*
 * Strict on purpose. episode-markers.ts reads a dozen looser conventions
 * ("Ep 7", "2⁄5", "- 201 -") for ordering files inside a group someone has
 * already made; here a marker alone takes a file off the site, so only the
 * forms nobody uses for a film count.
 */
const SXXEYY = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i;
const NXNN = /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9a-z])/i;

/** A folder that is one season of a show, not the show: "Season 2", "S02", "Series 1", "Specials". */
const SEASON_FOLDER = /^(?:season|series|staffel|saison|temporada|stagione|s)[ ._-]*\d{1,2}$|^specials?$/i;

export interface FilenameMarker {
  season: number;
  episode: number;
  /** Where in the stem the marker starts — what precedes it is the show's name, if anything. */
  index: number;
}

/** The SxxEyy / 3x07 marker in a path's filename, or null. */
export function filenameEpisodeMarker(path: string): FilenameMarker | null {
  const stem = stemOf(path);
  for (const pattern of [SXXEYY, NXNN]) {
    const m = pattern.exec(stem);
    if (!m) continue;
    const lead = m[0].length - m[0].replace(/^[^a-z0-9]/i, "").length;
    return { season: Number(m[1]), episode: Number(m[2]), index: m.index + lead };
  }
  return null;
}

/** Whether a file is recognised as an episode by any of the evidence above. */
export function isRecognisedEpisode(file: EpisodeFile): boolean {
  return metadataKey(file) !== null || filenameEpisodeMarker(file.path) !== null;
}

function stemOf(path: string): string {
  const base = posix.basename(path);
  const ext = posix.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

function metadataKey(file: EpisodeFile): { key: string; evidence: SeriesEvidence } | null {
  if (file.omdb?.type === "episode" && file.omdb.seriesImdbId) {
    return { key: `imdb:${file.omdb.seriesImdbId}`, evidence: "omdb" };
  }
  if (file.tmdbTvId !== null) return { key: `tmdb:${file.tmdbTvId}`, evidence: "tmdb" };
  return null;
}

/**
 * The folder that is the show: the file's own folder, or the one above it
 * when that is a season folder. Null at the library root, which is nobody's
 * show.
 */
export function showFolderOf(path: string, libraryRoot: string): string | null {
  const root = libraryRoot.replace(/\/+$/, "");
  let dir = posix.dirname(path);
  if (SEASON_FOLDER.test(posix.basename(dir))) dir = posix.dirname(dir);
  if (dir === root || dir === "." || dir === "/" || !dir.startsWith(root + "/")) return null;
  return dir;
}

/** "Nirvanna.the.Band.the.Show." -> "nirvanna the band the show"; "" when nothing precedes the marker. */
export function normaliseShowPrefix(prefix: string): string {
  return tidyName(prefix).toLowerCase();
}

function tidyName(raw: string): string {
  return raw
    .replace(/[._]+/g, " ")
    .replace(/[([]\s*(?:19|20)\d{2}\s*[)\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "")
    .trim();
}

function prefixOf(path: string, marker: FilenameMarker | null): string {
  if (!marker) return "";
  return stemOf(path).slice(0, marker.index);
}

/** Union-find over indexes, so the joins below can be stated one rule at a time. */
class Joins {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]!]!;
      i = this.parent[i]!;
    }
    return i;
  }
  join(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

interface Candidate {
  file: EpisodeFile;
  meta: { key: string; evidence: SeriesEvidence } | null;
  marker: FilenameMarker | null;
  showFolder: string | null;
  prefix: string;
  /** True when the file sits in a season folder, which says its parent folder is one show. */
  inSeasonFolder: boolean;
}

/**
 * Every series found among `files`. `files` should be the whole library (what
 * is not an episode is ignored), because whether a folder's name is the
 * show's name depends on what else is in that folder.
 */
export function detectSeries(files: EpisodeFile[], libraryRoot: string): SeriesCluster[] {
  const candidates: Candidate[] = [];
  /** How many files of any kind sit under each show folder. */
  const filesInFolder = new Map<string, number>();

  for (const file of files) {
    const folder = showFolderOf(file.path, libraryRoot);
    if (folder) filesInFolder.set(folder, (filesInFolder.get(folder) ?? 0) + 1);

    const meta = metadataKey(file);
    const marker = filenameEpisodeMarker(file.path);
    if (!meta && !marker) continue;
    candidates.push({
      file,
      meta,
      marker,
      showFolder: folder,
      prefix: normaliseShowPrefix(prefixOf(file.path, marker)),
      inSeasonFolder: SEASON_FOLDER.test(posix.basename(posix.dirname(file.path))),
    });
  }

  const joins = new Joins(candidates.length);

  // 1. The same series by metadata. OMDb and TMDB name the same show with
  //    different ids; a file that has both ties the two together.
  const firstByKey = new Map<string, number>();
  const tie = (key: string, i: number) => {
    const seen = firstByKey.get(key);
    if (seen === undefined) firstByKey.set(key, i);
    else joins.join(seen, i);
  };
  candidates.forEach((c, i) => {
    if (c.meta) tie(c.meta.key, i);
    if (c.meta && c.file.tmdbTvId !== null) tie(`tmdb:${c.file.tmdbTvId}`, i);
  });

  // 2. Filename-only files: the same show folder and the same name before the
  //    marker is the same show.
  const filenameOnly = candidates.map((c, i) => ({ c, i })).filter(({ c }) => !c.meta);
  const byFolderPrefix = new Map<string, number>();
  for (const { c, i } of filenameOnly) {
    const at = `${c.showFolder ?? posix.dirname(c.file.path)}|${c.prefix}`;
    const seen = byFolderPrefix.get(at);
    if (seen === undefined) byFolderPrefix.set(at, i);
    else joins.join(seen, i);
  }

  // 3. Filename-only files and the metadata-identified series beside them.
  //    The folder decides when it holds exactly one such series ("NtBtS" next
  //    to season one, which OMDb knows); otherwise only a matching name does.
  const seriesInFolder = new Map<string, Set<number>>();
  const seriesPrefixes = new Map<number, Set<string>>();
  candidates.forEach((c, i) => {
    if (!c.meta) return;
    const root = joins.find(i);
    if (c.showFolder) {
      const set = seriesInFolder.get(c.showFolder) ?? new Set<number>();
      set.add(root);
      seriesInFolder.set(c.showFolder, set);
    }
    if (c.prefix) {
      const set = seriesPrefixes.get(root) ?? new Set<string>();
      set.add(`${c.showFolder ?? ""}|${c.prefix}`);
      seriesPrefixes.set(root, set);
    }
  });
  for (const { c, i } of filenameOnly) {
    if (!c.showFolder) continue;
    const series = [...(seriesInFolder.get(c.showFolder) ?? [])];
    if (series.length === 1) {
      joins.join(series[0]!, i);
      continue;
    }
    const named = series.filter((root) => seriesPrefixes.get(root)?.has(`${c.showFolder}|${c.prefix}`));
    if (named.length === 1) joins.join(named[0]!, i);
  }

  // 4. Filename-only files under one show folder with different names before
  //    the marker ("NtBtS.S02E01" and "Nirvanna.the.Band.the.Show.S01E01") are
  //    one show when the folder is laid out as one — split into season
  //    folders — or when one of them has no name at all ("S01E01.mkv").
  //    A plain folder of mixed shows stays split by name.
  const folderGroups = new Map<string, number[]>();
  for (const { c, i } of filenameOnly) {
    if (!c.showFolder) continue;
    if (seriesInFolder.has(c.showFolder)) continue; // step 3 has decided these
    const list = folderGroups.get(c.showFolder) ?? [];
    list.push(i);
    folderGroups.set(c.showFolder, list);
  }
  for (const members of folderGroups.values()) {
    const seasonLaidOut = members.some((i) => candidates[i]!.inSeasonFolder);
    const names = new Set(members.map((i) => candidates[i]!.prefix).filter(Boolean));
    const hasUnnamed = members.some((i) => !candidates[i]!.prefix);
    if (seasonLaidOut || (hasUnnamed && names.size <= 1)) {
      for (const i of members.slice(1)) joins.join(members[0]!, i);
    }
  }

  // Gather.
  const byRoot = new Map<number, number[]>();
  candidates.forEach((_, i) => {
    const root = joins.find(i);
    const list = byRoot.get(root) ?? [];
    list.push(i);
    byRoot.set(root, list);
  });

  const clusters: SeriesCluster[] = [];
  for (const members of byRoot.values()) {
    const cs = members.map((i) => candidates[i]!);
    // Most members agree; when a TMDB id has tied two OMDb ids together, the
    // majority names it, and the same one on every run (the key must not move).
    const seriesImdbId = majority(
      cs.filter((c) => c.meta?.evidence === "omdb").map((c) => c.file.omdb!.seriesImdbId!),
    );
    const tmdbIds = cs.map((c) => c.file.tmdbTvId).filter((id): id is number => id !== null);
    const tmdbTvId = tmdbIds.length ? Number(majority(tmdbIds.map(String))) : null;
    const evidence: SeriesEvidence = seriesImdbId ? "omdb" : tmdbTvId !== null ? "tmdb" : "filename";

    const folders = new Set(cs.map((c) => c.showFolder));
    const onlyFolder = folders.size === 1 ? [...folders][0] ?? null : null;
    // A folder is named after the show only when nothing else lives in it.
    const folderName =
      onlyFolder && filesInFolder.get(onlyFolder) === cs.length ? tidyName(posix.basename(onlyFolder)) || null : null;

    const rawPrefixes = cs.map((c) => tidyName(prefixOf(c.file.path, c.marker))).filter(Boolean);
    const filenameName = mostCommon(rawPrefixes);

    const firstPrefix = cs.map((c) => c.prefix).filter(Boolean).sort()[0] ?? "";
    const key = seriesImdbId
      ? `imdb:${seriesImdbId}`
      : tmdbTvId !== null
        ? `tmdb:${tmdbTvId}`
        : `file:${onlyFolder ?? posix.dirname(cs[0]!.file.path)}|${firstPrefix}`;

    clusters.push({
      key,
      seriesImdbId,
      tmdbTvId,
      evidence,
      paths: cs.map((c) => c.file.path).sort(),
      folderName,
      filenameName,
    });
  }
  return clusters.sort((a, b) => a.key.localeCompare(b.key));
}

/** The most frequent value, ties to the first in sort order; null for none. */
function majority(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of [...values].sort()) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** The most frequent value, ties to the longer (the fuller spelling of a name). */
function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestN = 0;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && v.length > best.length)) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/**
 * The name a new group gets, best source first: what OMDb or TMDB calls the
 * series, then the show's own folder, then the filenames, then a placeholder
 * nobody will mistake for a real title.
 */
export function seriesDisplayName(cluster: SeriesCluster, metadataName: string | null): string {
  return metadataName?.trim() || cluster.folderName || cluster.filenameName || "Untitled show";
}

/** Whether a group's name and a series name are the same title, ignoring case, punctuation and a year. */
export function sameShowName(a: string, b: string): boolean {
  const norm = (s: string) =>
    tidyName(s)
      .toLowerCase()
      .replace(/^the\s+/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const na = norm(a);
  return na.length > 0 && na === norm(b);
}

/* ------------------------------------------------------------------ *
 * What to do about each series
 * ------------------------------------------------------------------ */

export interface ExistingGroup {
  groupId: string;
  name: string;
  /** The series IMDb id the group is linked to (library_group_series), if any. */
  seriesImdbId: string | null;
  /** The TMDB show the group is linked to (tmdb_links), if any. */
  tmdbTvId: number | null;
}

export interface GroupingState {
  /** Every grouped path and its group. */
  groupOf: Map<string, string>;
  groups: ExistingGroup[];
  /** Series keys whose group the curator dissolved. */
  declinedKeys: Set<string>;
  /** Files the curator took out of a group, or whose group they dissolved. */
  declinedPaths: Set<string>;
  /** What each series is called, where OMDb or TMDB has said. */
  names: Map<string, string>;
}

export type GroupingStep =
  | { action: "create"; key: string; name: string; paths: string[]; cluster: SeriesCluster }
  | { action: "add"; key: string; groupId: string; groupName: string; paths: string[]; cluster: SeriesCluster }
  | {
      action: "wait";
      key: string;
      name: string;
      paths: string[];
      cluster: SeriesCluster;
      why: "dissolved" | "one-file" | "ambiguous";
    };

/**
 * For each series, what the nightly pass does with its files that are in no
 * group yet.
 *
 * Existing groups are only ever added to, never changed: nothing here moves a
 * grouped file, splits a group or renames one, whoever made it. A new episode
 * joins the group its siblings are already in; failing that, a group linked
 * to the same series or carrying its name. A new group is made only for two
 * or more files and never for a series whose group the curator dissolved;
 * what is left waits for the curator, as "Needs you" in the console.
 *
 * A file the curator took out of a group, or whose group they dissolved, is
 * theirs: it is not grouped again and not hidden.
 */
export function planGrouping(clusters: SeriesCluster[], state: GroupingState): GroupingStep[] {
  const steps: GroupingStep[] = [];
  for (const cluster of clusters) {
    const loose = cluster.paths.filter((p) => !state.groupOf.has(p) && !state.declinedPaths.has(p));
    if (loose.length === 0) continue;
    const name = seriesDisplayName(cluster, state.names.get(cluster.key) ?? null);

    const siblingGroups = new Set(
      cluster.paths.map((p) => state.groupOf.get(p)).filter((g): g is string => g !== undefined),
    );
    let target: ExistingGroup | null = null;
    if (siblingGroups.size > 1) {
      steps.push({ action: "wait", key: cluster.key, name, paths: loose, cluster, why: "ambiguous" });
      continue;
    }
    if (siblingGroups.size === 1) {
      const id = [...siblingGroups][0]!;
      target = state.groups.find((g) => g.groupId === id) ?? null;
    } else {
      const linked = state.groups.filter(
        (g) =>
          (cluster.seriesImdbId !== null && g.seriesImdbId === cluster.seriesImdbId) ||
          (cluster.tmdbTvId !== null && g.tmdbTvId === cluster.tmdbTvId),
      );
      const named = linked.length > 0 ? linked : state.groups.filter((g) => sameShowName(g.name, name));
      if (named.length > 1) {
        steps.push({ action: "wait", key: cluster.key, name, paths: loose, cluster, why: "ambiguous" });
        continue;
      }
      target = named[0] ?? null;
    }

    if (target) {
      steps.push({ action: "add", key: cluster.key, groupId: target.groupId, groupName: target.name, paths: loose, cluster });
    } else if (state.declinedKeys.has(cluster.key)) {
      steps.push({ action: "wait", key: cluster.key, name, paths: loose, cluster, why: "dissolved" });
    } else if (loose.length < 2) {
      steps.push({ action: "wait", key: cluster.key, name, paths: loose, cluster, why: "one-file" });
    } else {
      steps.push({ action: "create", key: cluster.key, name, paths: loose, cluster });
    }
  }
  return steps;
}
