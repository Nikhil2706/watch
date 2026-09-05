import "server-only";

import { dirname } from "node:path";

import { env } from "./env";
import { episodeLabel, parseEpisodeInfo } from "./episode-naming";
import { getAdminMovies } from "./admin-library-cache";
import { adminThumbUrl } from "./admin-thumb";
import { hasNoSubtitles, type AdminMovieListItem } from "./jellyfin";
import {
  getExcludedPathSet,
  getGroup,
  getGroupedPathMap,
  getGroupKind,
  getGroupOverview,
  getGroupSeriesId,
  getWhitelistedPathSet,
  type GroupKind,
} from "./library-curation";

/**
 * Duplicate detection, thin-metadata detection and missing-subtitle detection
 * for the review dashboard — pure read-only analysis of the current Jellyfin
 * catalogue. Every action the dashboard offers (exclude, group, whitelist,
 * fix metadata) either writes to this app's own database
 * (library-curation.ts) or to Jellyfin's metadata store via the
 * RemoteSearch/manual-metadata paths in jellyfin.ts — never to the files
 * themselves, so this module has no file-move code in it at all.
 */

export interface ReviewItem {
  id: string;
  name: string;
  year: number | null;
  path: string | null;
  /** file:// link to the containing folder, if HOST_MEDIA_PATH is configured — lets the admin eyeball the file before deciding. */
  fileUrl: string | null;
  /** Human-readable Windows path, for display/copy next to the link. */
  localPath: string | null;
}

export interface DuplicateGroup {
  key: string;
  items: ReviewItem[];
}

export interface ThinMetadataGroup {
  /** The shared parent folder, e.g. "Kane Pixels - The Backrooms" — how these cluster in the UI. */
  folder: string;
  items: ReviewItem[];
}

// Exported for reuse by src/lib/scraping/match.ts — the same "how similar is
// this raw title to a library title" question, just applied to scraped
// article/accolade titles instead of duplicate-file detection.
export function normaliseTitle(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * jellyfinPath is container-internal ("/media/Horror/x.mp4"); the admin's
 * actual Explorer window only understands the host path behind that mount.
 * Returns null when HOST_MEDIA_PATH isn't configured rather than guessing —
 * a missing link is obviously missing, a wrong one wastes a click on a 404.
 */
function toHostFolder(jellyfinPath: string | undefined): string | null {
  if (!env.hostMediaPath || !jellyfinPath?.startsWith("/media/")) return null;
  const rel = dirname(jellyfinPath.slice("/media/".length));
  const root = env.hostMediaPath.replace(/[/\\]+$/, "");
  return rel === "." ? root : `${root}/${rel}`;
}

function toFileUrl(hostFolder: string): string {
  // file:///E:/Da%20Moveesh/Horror/... — every segment percent-encoded except
  // the drive letter itself, which must stay a bare "E:" for Windows to
  // recognise it.
  const segments = hostFolder.split(/[/\\]/).filter(Boolean);
  const encoded = segments.map((s, i) => (i === 0 ? s : encodeURIComponent(s)));
  return "file:///" + encoded.join("/");
}

function toReviewItem(m: AdminMovieListItem): ReviewItem {
  const hostFolder = toHostFolder(m.Path);
  return {
    id: m.Id,
    name: m.Name,
    year: m.ProductionYear ?? null,
    path: m.Path ?? null,
    fileUrl: hostFolder ? toFileUrl(hostFolder) : null,
    localPath: hostFolder ? hostFolder.replace(/\//g, "\\") : null,
  };
}

function hasNoMetadata(m: AdminMovieListItem): boolean {
  return !m.Overview && !m.ProviderIds?.Tmdb && !m.ProviderIds?.Imdb;
}

export async function buildLibraryReview(): Promise<{
  duplicates: DuplicateGroup[];
  thinMetadata: ThinMetadataGroup[];
  missingSubtitles: ReviewItem[];
  totalMovies: number;
}> {
  const all = await getAdminMovies();

  // Already-decided paths (excluded, grouped, or explicitly whitelisted
  // despite having no metadata) are resolved — they stop presenting as open
  // problems the moment a decision is recorded, without needing Jellyfin to
  // know anything happened.
  const excluded = getExcludedPathSet();
  const grouped = getGroupedPathMap();
  const whitelisted = getWhitelistedPathSet();
  const decided = (path: string | undefined) =>
    !!path && (excluded.has(path) || grouped.has(path));
  const movies = all.filter((m) => !decided(m.Path));

  const byTitle = new Map<string, ReviewItem[]>();
  for (const m of movies) {
    const key = normaliseTitle(m.Name);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(toReviewItem(m));
  }
  const duplicates: DuplicateGroup[] = [...byTitle.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, items }))
    .sort((a, b) => b.items.length - a.items.length);

  const thin = movies.filter(
    (m) => hasNoMetadata(m) && !(m.Path && whitelisted.has(m.Path)),
  );
  const byFolder = new Map<string, ReviewItem[]>();
  for (const m of thin) {
    const folder = m.Path ? dirname(m.Path) : "(unknown folder)";
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(toReviewItem(m));
  }
  const thinMetadata: ThinMetadataGroup[] = [...byFolder.entries()]
    .map(([folder, items]) => ({ folder, items }))
    .sort((a, b) => b.items.length - a.items.length);

  // "Visible" here mirrors media.ts's filterVisible: not excluded, and has
  // either real metadata or an explicit whitelist — i.e. something a viewer
  // could actually be watching right now, which is the set worth checking
  // for missing captions. A file still stuck in the thin-metadata pile isn't
  // on the site yet, so it isn't a subtitle problem yet either.
  const missingSubtitles = all
    .filter((m) => !decided(m.Path))
    .filter((m) => !hasNoMetadata(m) || (m.Path && whitelisted.has(m.Path)))
    .filter((m) => hasNoSubtitles(m))
    .map(toReviewItem);

  return { duplicates, thinMetadata, missingSubtitles, totalMovies: all.length };
}

export interface BrowseItem extends ReviewItem {
  jellyfinId: string;
  imdbId: string | null;
  tmdbId: string | null;
  overview: string;
  isDuplicate: boolean;
  isThinMetadata: boolean;
  isMissingSubtitles: boolean;
  isWhitelisted: boolean;
  isExcluded: boolean;
  isGrouped: boolean;
  groupName: string | null;
  /** The group this file belongs to, so a row can open its show without a second lookup — the workspace collapses a show to ONE row and needs to know which. */
  groupId: string | null;
  /** Signed thumbnail URL, or null when the item has no poster. NOT a /jf/ path: the console is a file:// page whose cookies never reach the site (see src/app/api/admin/thumb). */
  posterUrl: string | null;
  /** Vertical resolution, e.g. 1080. Null when Jellyfin reports no video stream. */
  height: number | null;
  /** Bytes on disk, null when unknown. */
  sizeBytes: number | null;
  /** How many subtitle streams the file carries, embedded or external. */
  subtitleCount: number;
  /** Pins a row to the top of the redesigned browse UI's default sort — anything the curator hasn't resolved yet. */
  needsDecision: boolean;
}

/**
 * Every movie in the library, flat, for the redesigned browse UI (item 5 of
 * the 2026-08-19 batch: "browsable all movies, on top the ones that need
 * decision but ... search/filter/scroll ... click on a movie"). The three
 * existing category buckets above (duplicates/thinMetadata/missingSubtitles)
 * stay as they are — this is a parallel, flat view of the SAME underlying
 * data, computed once here rather than making the UI reconcile three
 * separately-shaped lists against one search box.
 */
export async function buildLibraryBrowse(): Promise<BrowseItem[]> {
  const all = await getAdminMovies();

  const excluded = getExcludedPathSet();
  const grouped = getGroupedPathMap();
  const whitelisted = getWhitelistedPathSet();

  const byTitle = new Map<string, number>();
  for (const m of all) {
    const key = normaliseTitle(m.Name);
    if (!key) continue;
    byTitle.set(key, (byTitle.get(key) ?? 0) + 1);
  }

  return all.map((m) => {
    const path = m.Path;
    const review = toReviewItem(m);
    const isExcluded = !!path && excluded.has(path);
    const groupInfo = path ? grouped.get(path) : undefined;
    const isWhitelisted = !!path && whitelisted.has(path);
    const isThinMetadata = hasNoMetadata(m);
    const isDuplicate = (byTitle.get(normaliseTitle(m.Name)) ?? 0) > 1;
    // Same "visible" definition as missingSubtitles above — a file still
    // stuck in the thin-metadata pile isn't a subtitle problem yet either.
    const isVisible = !isExcluded && (!isThinMetadata || isWhitelisted);
    const isMissingSubtitles = isVisible && hasNoSubtitles(m);

    /*
     * Facts about the file itself, carried so the workspace can compare two
     * copies of the same film side by side. Resolution, size and whether it
     * has subtitles ARE the basis for choosing between duplicates, and the old
     * duplicates panel showed none of them. Free here: this builder already
     * asks Jellyfin for MediaSources to answer the missing-subtitle question.
     */
    const source = m.MediaSources?.[0];
    const streams = source?.MediaStreams ?? [];
    const video = streams.find((stream) => stream.Type === "Video");

    return {
      ...review,
      jellyfinId: m.Id,
      groupId: groupInfo?.groupId ?? null,
      posterUrl: adminThumbUrl(m.Id, m.ImageTags?.Primary),
      height: video?.Height ?? null,
      sizeBytes: source?.Size ?? null,
      subtitleCount: streams.filter((stream) => stream.Type === "Subtitle").length,
      imdbId: m.ProviderIds?.Imdb ?? null,
      tmdbId: m.ProviderIds?.Tmdb ?? null,
      overview: m.Overview ?? "",
      isDuplicate,
      isThinMetadata,
      isMissingSubtitles,
      isWhitelisted,
      isExcluded,
      isGrouped: !!groupInfo,
      groupName: groupInfo?.groupName ?? null,
      needsDecision: !isExcluded && !groupInfo && ((isThinMetadata && !isWhitelisted) || isDuplicate),
    };
  });
}

export interface GroupMemberItem extends ReviewItem {
  /** "Episode 7", "Episode 7: Title", or null when the filename carries no episode marker. */
  label: string | null;
  /** Parsed from the filename — null for both when no marker was found. */
  season: number | null;
  episode: number | null;
}

export interface GroupDetail {
  groupId: string;
  groupName: string;
  overview: string | null;
  /** The real TV series' IMDb id, if the admin has set one — what makes per-episode OMDb fetch possible. */
  seriesImdbId: string | null;
  /** "series" | "movie" | null — decides whether tiles read "N episodes" or "N parts". Null until a series fetch or the curator settles it. */
  kind: GroupKind | null;
  items: GroupMemberItem[];
}

/**
 * One group's members for the "Manage" panel — episode-ordered, each
 * carrying its current (possibly wrong) Jellyfin match so the admin can spot
 * and fix a mis-tagged file without it ever showing up in the thin-metadata
 * or duplicates lists (it has metadata; it's just metadata for the wrong
 * thing).
 */
export async function buildGroupDetail(groupId: string): Promise<GroupDetail | null> {
  const group = getGroup(groupId);
  if (!group) return null;

  const pathSet = new Set(group.paths);
  const all = await getAdminMovies();
  const items: GroupMemberItem[] = all
    .filter((m) => m.Path && pathSet.has(m.Path))
    .map((m) => {
      const parsed = parseEpisodeInfo(m.Path ?? "");
      return {
        review: toReviewItem(m),
        label: episodeLabel(parsed),
        season: parsed.season,
        episode: parsed.episode,
        sortKey: parsed.sortKey,
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey || (a.review.path ?? "").localeCompare(b.review.path ?? ""))
    .map(({ review, label, season, episode }) => ({ ...review, label, season, episode }));

  return {
    groupId,
    groupName: group.groupName,
    overview: getGroupOverview(groupId),
    seriesImdbId: getGroupSeriesId(groupId),
    kind: getGroupKind(groupId),
    items,
  };
}

/**
 * Matches the DirectPlayProfiles the app advertises to browsers in
 * media.ts's getPlaybackPlan, and mirrors alreadyPlayable() in
 * scripts/media-worker.mjs — same rule, read from Jellyfin's own analysis
 * instead of running ffprobe again (this app has no ffmpeg; only the worker
 * does).
 */
function isDirectPlayable(m: AdminMovieListItem): boolean {
  const source = m.MediaSources?.[0];
  const container = (source?.Container ?? "").toLowerCase();
  const video = source?.MediaStreams?.find((s) => s.Type === "Video");
  const width = video?.Width ?? 0;
  return (
    (container === "mp4" || container === "m4v") &&
    (video?.Codec ?? "").toLowerCase() === "h264" &&
    width > 0 &&
    width <= 1920
  );
}

export interface TransformCandidate extends ReviewItem {
  container: string | null;
  codec: string | null;
  /** e.g. "3840x1608 · HEVC" — why this file needs converting, for the admin to judge at a glance. */
  quality: string | null;
}

/**
 * Files that would make a browser fall back to a live transcode instead of
 * playing directly — the worker's own job, but listed here (no ffmpeg
 * needed, Jellyfin already probed these) so the dashboard can offer a
 * Transform button per file without the worker running on its own.
 */
export async function listTransformCandidates(): Promise<TransformCandidate[]> {
  const all = await getAdminMovies();
  const excluded = getExcludedPathSet();

  return all
    .filter((m) => m.Path && !excluded.has(m.Path))
    .filter((m) => !isDirectPlayable(m))
    .map((m) => {
      const source = m.MediaSources?.[0];
      const video = source?.MediaStreams?.find((s) => s.Type === "Video");
      const dims = video?.Width && video?.Height ? `${video.Width}x${video.Height}` : null;
      return {
        ...toReviewItem(m),
        container: source?.Container ?? null,
        codec: video?.Codec ?? null,
        quality: [dims, video?.Codec?.toUpperCase()].filter(Boolean).join(" · ") || null,
      };
    });
}
