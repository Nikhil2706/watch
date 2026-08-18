import "server-only";

import { parseEpisodeInfo } from "./episode-naming";
import { userFetch, userPost } from "./jellyfin";
import {
  getAllGroupSeriesPosters,
  getConfirmedPathSet,
  getExcludedPathSet,
  getGroup,
  getGroupedPathMap,
  getGroupOverview,
  getGroupSeriesId,
  getGroupSeriesMeta,
  getGroupSeriesPoster,
  getWhitelistedPathSet,
} from "./library-curation";
import { getRatings, type Ratings } from "./ratings";
import { stripCredentials } from "./strip-credentials";
import type { ResolvedSession } from "./session";

/**
 * Catalogue reads for the browsing UI.
 *
 * Everything Jellyfin already knows — artwork, genres, cast, resume positions,
 * "recently added" — is used as-is rather than reinvented here. Jellyfin is the
 * organisation layer; this app is the gate in front of it.
 *
 * All image URLs produced here point at /jf/*, so the browser fetches artwork
 * through the proxy with only its session cookie.
 */

export interface MediaItem {
  Id: string;
  Name: string;
  Type: string;
  /** Container path, e.g. "/media/Horror/x.mp4" — how excluded/grouped decisions match against a fetched item. */
  Path?: string;
  Overview?: string;
  ProductionYear?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  /** External ids from Jellyfin's metadata providers; `Imdb` keys OMDb. */
  ProviderIds?: Record<string, string>;
  RunTimeTicks?: number;
  Genres?: string[];
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
    IsFavorite?: boolean;
  };
  People?: Array<{
    Name: string;
    Role?: string;
    Type: string;
    Id: string;
    /** Present only when Jellyfin has a portrait for this person. */
    PrimaryImageTag?: string;
  }>;
  MediaSources?: Array<{
    Id: string;
    Container?: string;
    Size?: number;
    MediaStreams?: Array<{
      Type: string;
      Codec?: string;
      Height?: number;
      Width?: number;
      DisplayTitle?: string;
      Title?: string;
      Language?: string;
      Index: number;
      IsExternal?: boolean;
      IsForced?: boolean;
      IsDefault?: boolean;
      IsHearingImpaired?: boolean;
    }>;
  }>;
}

interface ItemsResponse {
  Items: MediaItem[];
  TotalRecordCount: number;
}

/** Ticks are 100ns units. Jellyfin uses them everywhere. */
const TICKS_PER_MS = 10_000;

// ProviderIds rides along so the featured title can show its IMDb score
// without a second round trip for the full item. Path rides along so the
// library-curation exclude/group decisions (keyed on path, not item id) can
// be applied to whatever list this produced — see filterVisible below.
const LIST_FIELDS =
  "PrimaryImageAspectRatio,Overview,Genres,ProductionYear,CommunityRating,OfficialRating,MediaSourceCount,RunTimeTicks,UserData,ProviderIds,Path";

const DETAIL_FIELDS =
  "Overview,Genres,ProductionYear,CommunityRating,OfficialRating,People,MediaSources,MediaStreams,Studios,Taglines,ProviderIds,Path";

function creds(session: ResolvedSession) {
  return [session.jellyfinToken, session.jellyfinDeviceId] as const;
}

function hasNoMetadata(item: MediaItem): boolean {
  return !item.Overview && !item.ProviderIds?.Tmdb && !item.ProviderIds?.Imdb;
}

/**
 * Drops anything the review dashboard excluded, PLUS anything with no fetched
 * metadata at all that hasn't been explicitly whitelisted — a title with no
 * overview, no TMDB/IMDb id and no poster is an open question for the review
 * dashboard, not something to hand a viewer. Two local SQLite reads, not a
 * Jellyfin call — cheap enough to run on every list this module returns.
 */
function filterVisible(items: MediaItem[]): MediaItem[] {
  const excluded = getExcludedPathSet();
  const whitelisted = getWhitelistedPathSet();
  return items.filter((item) => {
    if (item.Path && excluded.has(item.Path)) return false;
    if (hasNoMetadata(item) && !(item.Path && whitelisted.has(item.Path))) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

/** Continue Watching. Jellyfin tracks the resume position; we just render it. */
export async function getResume(session: ResolvedSession): Promise<MediaItem[]> {
  const [token, device] = creds(session);
  const data = await userFetch<ItemsResponse>(token, device, "/UserItems/Resume", {
    userId: session.jellyfinUserId,
    limit: 12,
    mediaTypes: "Video",
    fields: LIST_FIELDS,
    enableImageTypes: "Primary,Backdrop,Thumb",
  });
  return filterVisible(data?.Items ?? []);
}

export async function getLatest(session: ResolvedSession): Promise<MediaItem[]> {
  const [token, device] = creds(session);
  // /Items/Latest returns a bare array, not the usual {Items,TotalRecordCount}.
  const data = await userFetch<MediaItem[]>(token, device, "/Items/Latest", {
    userId: session.jellyfinUserId,
    limit: 20,
    includeItemTypes: "Movie",
    fields: LIST_FIELDS,
    enableImageTypes: "Primary,Backdrop",
  });
  return filterVisible(Array.isArray(data) ? data : []);
}

/**
 * Short-lived cache for getAllMovies()'s result, keyed per Jellyfin user
 * (the response carries that user's own UserData — watch state, favorites —
 * so a shared cache across users would leak one viewer's progress into
 * another's page). Several call sites (Browse, Search's broad-match fallback,
 * and — via getCollection() — every Collection page and every grouped-episode
 * item page) each independently pull up to 2000 items just to filter it down
 * to what they actually need; this doesn't remove that per-call cost on a
 * cold cache, but it means a user browsing several pages or episodes in one
 * sitting pays for one Jellyfin round trip instead of one per click. The TTL
 * is short enough that a mark-watched/rating change is stale for at most a
 * few seconds — well under what would be noticeable, and far shorter than
 * browse_people_cache's 12h TTL because this one carries per-user state.
 */
const ALL_MOVIES_CACHE_TTL_MS = 20_000;

interface AllMoviesCacheEntry {
  data: MediaItem[];
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateAllMoviesCache: Map<string, AllMoviesCacheEntry> | undefined;
}

function allMoviesCache(): Map<string, AllMoviesCacheEntry> {
  if (!globalThis.__jellyfinGateAllMoviesCache) {
    globalThis.__jellyfinGateAllMoviesCache = new Map();
  }
  return globalThis.__jellyfinGateAllMoviesCache;
}

export async function getAllMovies(
  session: ResolvedSession,
  options: { limit?: number; sortBy?: string; genre?: string } = {},
): Promise<MediaItem[]> {
  const cacheKey = `${session.jellyfinUserId}:${options.limit ?? 2000}:${options.sortBy ?? "SortName"}:${options.genre ?? ""}`;
  const cache = allMoviesCache();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const [token, device] = creds(session);
  const data = await userFetch<ItemsResponse>(token, device, "/Items", {
    userId: session.jellyfinUserId,
    recursive: true,
    includeItemTypes: "Movie",
    sortBy: options.sortBy ?? "SortName",
    sortOrder: "Ascending",
    // Was 200. Silently truncated the library the moment it passed 200 titles
    // — Browse showed "181 movies" while Jellyfin had 446. 2000 comfortably
    // covers any library this app is realistically pointed at.
    limit: options.limit ?? 2000,
    genres: options.genre,
    fields: LIST_FIELDS,
    enableImageTypes: "Primary,Backdrop",
  });
  const result = filterVisible(data?.Items ?? []);
  cache.set(cacheKey, { data: result, expiresAt: Date.now() + ALL_MOVIES_CACHE_TTL_MS });
  return result;
}

export interface PersonCredit {
  Name: string;
  Type: string;
  Id: string;
  PrimaryImageTag?: string;
}

/**
 * Every movie's cast/director credits, and NOTHING else — Browse's
 * director/actor dimensions are the only caller, and even alone the People
 * field costs ~20 SECONDS against Jellyfin, independent of what else is on
 * the request (measured directly: a People-only fetch and a People-plus-
 * every-other-field fetch differed by about two seconds, so the field
 * itself is the entire cost — trimming the rest of the request doesn't
 * help). browse-data.ts is responsible for caching this in SQLite so that
 * cost is paid rarely, not per page load; this function only knows how to
 * fetch it, not how to cache it.
 */
export async function getPeopleForAllMovies(session: ResolvedSession): Promise<Map<string, PersonCredit[]>> {
  const [token, device] = creds(session);
  const data = await userFetch<ItemsResponse>(
    token,
    device,
    "/Items",
    {
      recursive: true,
      includeItemTypes: "Movie",
      limit: 2000,
      fields: "People",
    },
    90_000,
  );
  const map = new Map<string, PersonCredit[]>();
  for (const item of data?.Items ?? []) {
    map.set(item.Id, item.People ?? []);
  }
  return map;
}

export interface ResolvedGroup {
  groupId: string;
  groupName: string;
  members: MediaItem[];
}

/**
 * Splits an already-fetched (already exclude-filtered) item list into what's
 * ungrouped and what belongs together — the review dashboard's grouping
 * decisions, resolved against *this* list rather than re-fetched from
 * Jellyfin. A local SQLite read plus an in-memory path match; no Jellyfin
 * round trip, and nothing here depends on Jellyfin item ids staying stable.
 */
export function splitByGroup(items: MediaItem[]): { ungrouped: MediaItem[]; groups: ResolvedGroup[] } {
  const groupedPaths = getGroupedPathMap();
  if (groupedPaths.size === 0) return { ungrouped: items, groups: [] };

  const byGroup = new Map<string, ResolvedGroup>();
  const ungrouped: MediaItem[] = [];
  for (const item of items) {
    const g = item.Path ? groupedPaths.get(item.Path) : undefined;
    if (!g) {
      ungrouped.push(item);
      continue;
    }
    let entry = byGroup.get(g.groupId);
    if (!entry) {
      entry = { groupId: g.groupId, groupName: g.groupName, members: [] };
      byGroup.set(g.groupId, entry);
    }
    entry.members.push(item);
  }
  // A group with only one member currently present (its siblings filtered out
  // by genre, say) reads better as a normal poster than a "group of one".
  const groups: ResolvedGroup[] = [];
  for (const g of byGroup.values()) {
    if (g.members.length > 1) groups.push(g);
    else ungrouped.push(...g.members);
  }
  return { ungrouped, groups };
}

export interface CollectionItem {
  item: MediaItem;
  /**
   * "Episode 7", "Episode 7: Title" when the filename carries a season/
   * episode marker, otherwise null — Jellyfin's own per-file match is often
   * wrong (each file was matched as its own movie), so this only overrides
   * the displayed title when the filename itself is confident about the
   * part number. Nothing here touches item.Name or Jellyfin's stored match.
   */
  label: string | null;
}

export interface CollectionDetail {
  Id: string;
  Name: string;
  Overview?: string;
  /** The real series' own poster, if the admin has linked one — never any one episode's. */
  posterSrc?: string | null;
  genres: string[];
  actors: string[];
  director: string[];
  writer: string[];
  /** From ratings.ts's own cache, keyed on the series' IMDb id — same source a movie's detail page uses. */
  ratings: Ratings | null;
  items: CollectionItem[];
}

/**
 * "Episode 7", "Episode 7: Land of Enchantment", or null when the filename
 * has no episode marker at all. A path the admin has explicitly confirmed
 * (via Search/Manual/OMDb-fetch on the review dashboard) wins over the
 * filename's own guess — that's the whole point of fetching real episode
 * data. An unconfirmed Name is just Jellyfin's automatic guess, often for
 * the wrong film entirely, so it's never shown here.
 *
 * This uses this app's own confirmed-paths record rather than Jellyfin's
 * LockedFields: LockedFields is set correctly but Jellyfin's /Items LIST
 * endpoint silently drops it even when requested (verified against
 * 10.11.11), so it's not readable from the same bulk query this list
 * already runs.
 */
function resolveEpisodeLabel(
  item: MediaItem,
  parsed: ReturnType<typeof parseEpisodeInfo>,
  confirmedPaths: Set<string>,
): string | null {
  if (parsed.episode === null) return null;
  const base = `Episode ${parsed.episode}`;
  const nameConfirmed = item.Path && confirmedPaths.has(item.Path) && item.Name;
  const title = nameConfirmed ? item.Name : parsed.title;
  return title ? `${base}: ${title}` : base;
}

/** A group's name plus its current members, resolved fresh from Jellyfin by path. */
export async function getCollection(
  session: ResolvedSession,
  groupId: string,
): Promise<CollectionDetail | null> {
  const group = getGroup(groupId);
  if (!group) return null;

  const pathSet = new Set(group.paths);
  const confirmedPaths = getConfirmedPathSet();
  const all = await getAllMovies(session, { limit: 2000 });
  const items: CollectionItem[] = all
    .filter((item) => item.Path && pathSet.has(item.Path))
    .map((item) => {
      const parsed = parseEpisodeInfo(item.Path ?? "");
      return {
        item,
        label: resolveEpisodeLabel(item, parsed, confirmedPaths),
        sortKey: parsed.sortKey,
        path: item.Path ?? "",
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey || a.path.localeCompare(b.path))
    .map(({ item, label }) => ({ item, label }));

  const meta = getGroupSeriesMeta(groupId);
  const seriesImdbId = getGroupSeriesId(groupId);
  const ratings = seriesImdbId ? await getRatings(seriesImdbId).catch(() => null) : null;

  return {
    Id: groupId,
    Name: group.groupName,
    Overview: getGroupOverview(groupId) ?? undefined,
    posterSrc: getGroupSeriesPoster(groupId),
    genres: meta?.genres ?? [],
    actors: meta?.actors ?? [],
    director: meta?.director ?? [],
    writer: meta?.writer ?? [],
    ratings,
    items,
  };
}

export interface EpisodeContext {
  groupId: string;
  groupName: string;
  /** Every other episode's Jellyfin item id — for filtering this episode out of its own "More like this" row, which otherwise fills up with its siblings once they all share Genres/People from the same OMDb fetch. */
  siblingIds: Set<string>;
  /** Episodes after this one, in air order, for a "Future episodes" row. */
  future: CollectionItem[];
}

/**
 * Resolves which group (if any) an item belongs to, and where it sits in
 * that group's episode order. Null for anything that isn't part of a group
 * — an ordinary movie has no "future episodes" and needs no similar-items
 * filtering.
 */
export async function getEpisodeContext(
  session: ResolvedSession,
  item: MediaItem,
): Promise<EpisodeContext | null> {
  if (!item.Path) return null;
  const group = getGroupedPathMap().get(item.Path);
  if (!group) return null;

  const collection = await getCollection(session, group.groupId);
  if (!collection) return null;

  const index = collection.items.findIndex((ci) => ci.item.Id === item.Id);
  const siblingIds = new Set(collection.items.map((ci) => ci.item.Id));
  siblingIds.delete(item.Id);

  return {
    groupId: group.groupId,
    groupName: collection.Name,
    siblingIds,
    future: index === -1 ? [] : collection.items.slice(index + 1),
  };
}

/** Genre names that actually have movies behind them, most populous first. */
export async function getGenres(session: ResolvedSession): Promise<string[]> {
  const [token, device] = creds(session);
  const data = await userFetch<ItemsResponse>(token, device, "/Genres", {
    userId: session.jellyfinUserId,
    includeItemTypes: "Movie",
    sortBy: "SortName",
  });
  return (data?.Items ?? []).map((g) => g.Name);
}

/**
 * Reverse of getItem(): given an IMDb id (already resolved against the
 * library by matchTitle() at scrape time — see film-series.ts), find the
 * Jellyfin item it belongs to, for building a poster/link on a page that
 * only has the id, not the item, on hand. A single targeted query, not the
 * heavy admin-only listAllMoviesAdmin() pull — this runs on every viewer's
 * item-page render, not a background scrape.
 */
export async function getItemByImdbId(
  session: ResolvedSession,
  imdbId: string,
): Promise<MediaItem | null> {
  const [token, device] = creds(session);
  try {
    const result = await userFetch<{ Items: MediaItem[] }>(token, device, "/Items", {
      userId: session.jellyfinUserId,
      includeItemTypes: "Movie",
      recursive: true,
      anyProviderIdEquals: `Imdb.${imdbId}`,
      fields: "ProviderIds,ProductionYear,ImageTags",
      limit: 1,
    });
    return result.Items[0] ?? null;
  } catch {
    return null;
  }
}

export async function getItem(
  session: ResolvedSession,
  itemId: string,
): Promise<MediaItem | null> {
  const [token, device] = creds(session);
  try {
    return await userFetch<MediaItem>(token, device, `/Items/${encodeURIComponent(itemId)}`, {
      userId: session.jellyfinUserId,
      fields: DETAIL_FIELDS,
    });
  } catch {
    return null;
  }
}

export async function getSimilar(
  session: ResolvedSession,
  itemId: string,
): Promise<MediaItem[]> {
  const [token, device] = creds(session);
  try {
    const data = await userFetch<ItemsResponse>(
      token,
      device,
      `/Items/${encodeURIComponent(itemId)}/Similar`,
      { userId: session.jellyfinUserId, limit: 12, fields: LIST_FIELDS },
    );
    return filterVisible(data?.Items ?? []);
  } catch {
    return [];
  }
}

export async function search(
  session: ResolvedSession,
  query: string,
): Promise<MediaItem[]> {
  if (!query.trim()) return [];
  const [token, device] = creds(session);
  const data = await userFetch<ItemsResponse>(token, device, "/Items", {
    userId: session.jellyfinUserId,
    recursive: true,
    includeItemTypes: "Movie",
    searchTerm: query.trim(),
    limit: 60,
    fields: LIST_FIELDS,
    enableImageTypes: "Primary,Backdrop",
  });
  return filterVisible(data?.Items ?? []);
}

/* ------------------------------------------------------------------ *
 * Playback negotiation
 * ------------------------------------------------------------------ */

export interface PlaybackPlan {
  /** "direct" pipes the original file; "hls" makes Jellyfin transcode. */
  mode: "direct" | "hls";
  /** Always a /jf/* URL — the browser never talks to Jellyfin itself. */
  src: string;
  mediaSourceId: string;
  playSessionId: string;
  /** Why a transcode was chosen, straight from Jellyfin. For the UI to explain. */
  transcodeReasons: string[];
}

/**
 * A deliberately conservative browser profile.
 *
 * Direct play is claimed only for the combinations every browser handles: H.264
 * video with AAC/MP3 audio in an MP4 container, plus WebM. Everything else —
 * MKV containers, HEVC, TrueHD — is declared unsupported so Jellyfin transcodes
 * to HLS rather than sending something the <video> element will silently refuse.
 *
 * This is the honest profile for a browser client. Claiming more here would
 * produce a black screen instead of a transcode.
 */
/**
 * Ceiling for transcoded output.
 *
 * A transcode is only ever a fallback for a file the browser cannot play, and
 * re-encoding a 4K source at 4K is close to the worst thing you can ask of a
 * CPU. Measured on a 16-thread i5-1240P, software-transcoding a 3840x1920 HEVC
 * 10-bit source to H.264 at full resolution ran at 1.77x realtime — barely
 * ahead of playback, so any seek dropped it behind and the player stalled. On
 * the i3-6100 this is actually deployed to, the same job is well below realtime
 * and simply does not work.
 *
 * Capping the ladder at 1080p cuts the pixel count by ~4x. Nobody watching on a
 * phone over a home uplink can tell the difference, and it is the difference
 * between a transcode that keeps up and one that does not.
 */
const MAX_TRANSCODE_WIDTH = 1920;
const MAX_TRANSCODE_HEIGHT = 1080;
const MAX_TRANSCODE_BITRATE = 8_000_000;

const BROWSER_PROFILE = {
  // Was 120 Mbps, which told Jellyfin to spend an enormous bitrate re-encoding
  // 4K. Nothing streaming to a browser over a home connection needs that.
  MaxStreamingBitrate: MAX_TRANSCODE_BITRATE,
  DirectPlayProfiles: [
    { Container: "mp4,m4v", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,mp3" },
    { Container: "webm", Type: "Video", VideoCodec: "vp8,vp9,av1", AudioCodec: "vorbis,opus" },
  ],
  TranscodingProfiles: [
    {
      Container: "ts",
      Type: "Video",
      VideoCodec: "h264",
      AudioCodec: "aac",
      Protocol: "hls",
      Context: "Streaming",
      MaxAudioChannels: "2",
      MinSegments: 1,
      BreakOnNonKeyFrames: true,
    },
  ],
  ContainerProfiles: [],
  /**
   * This is what actually makes Jellyfin downscale. Without these conditions it
   * builds a `scale=` filter bounded by the *source* dimensions, which is a
   * no-op, and encodes at full resolution.
   *
   * `IsRequired: false` marks them as preferences rather than hard requirements:
   * Jellyfin brings the output down to satisfy them instead of refusing to play
   * anything that exceeds them.
   */
  CodecProfiles: [
    {
      Type: "Video",
      Codec: "h264",
      Conditions: [
        {
          Condition: "LessThanEqual",
          Property: "Width",
          Value: String(MAX_TRANSCODE_WIDTH),
          IsRequired: false,
        },
        {
          Condition: "LessThanEqual",
          Property: "Height",
          Value: String(MAX_TRANSCODE_HEIGHT),
          IsRequired: false,
        },
        {
          Condition: "LessThanEqual",
          Property: "VideoBitrate",
          Value: String(MAX_TRANSCODE_BITRATE),
          IsRequired: false,
        },
        // 4.1 is the highest level with broad hardware-decode support on
        // phones. Above it, some devices fall back to software decode and
        // drain the battery or drop frames.
        {
          Condition: "LessThanEqual",
          Property: "VideoLevel",
          Value: "41",
          IsRequired: false,
        },
      ],
    },
  ],
  SubtitleProfiles: [
    { Format: "vtt", Method: "External" },
    { Format: "srt", Method: "External" },
  ],
};

interface PlaybackInfoResponse {
  PlaySessionId: string;
  MediaSources: Array<{
    Id: string;
    SupportsDirectPlay?: boolean;
    SupportsDirectStream?: boolean;
    SupportsTranscoding?: boolean;
    TranscodingUrl?: string;
    TranscodeReasons?: string[];
  }>;
}

export async function getPlaybackPlan(
  session: ResolvedSession,
  itemId: string,
): Promise<PlaybackPlan | null> {
  const [token, device] = creds(session);

  const info = await userPost<PlaybackInfoResponse>(
    token,
    device,
    `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
    { DeviceProfile: BROWSER_PROFILE, EnableDirectPlay: true, EnableTranscoding: true },
    { userId: session.jellyfinUserId },
  );

  const source = info?.MediaSources?.[0];
  if (!source) return null;

  const reasons = source.TranscodeReasons ?? [];

  if (source.SupportsDirectPlay || source.SupportsDirectStream) {
    const params = new URLSearchParams({
      static: "true",
      mediaSourceId: source.Id,
    });
    return {
      mode: "direct",
      src: `/jf/Videos/${itemId}/stream?${params.toString()}`,
      mediaSourceId: source.Id,
      playSessionId: info.PlaySessionId,
      transcodeReasons: [],
    };
  }

  if (source.TranscodingUrl) {
    // Jellyfin returns a server-absolute path; prefixing /jf keeps the browser
    // on this origin.
    //
    // The URL itself embeds `&ApiKey=<session token>`. It is rendered into the
    // page as the player's src, so it must be stripped here — the proxy's
    // playlist rewriting only covers response bodies, not this URL. The token
    // is re-attached server-side when the browser requests it through /jf/*.
    return {
      mode: "hls",
      src: stripCredentials(`/jf${source.TranscodingUrl}`),
      mediaSourceId: source.Id,
      playSessionId: info.PlaySessionId,
      transcodeReasons: reasons,
    };
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

/**
 * Poster URL, routed through the proxy.
 *
 * The image `tag` is included so the URL changes when the artwork does — that
 * makes the response safely cacheable by the browser, which matters when a
 * grid pulls dozens of posters at once.
 */
export function posterUrl(item: MediaItem, width = 320): string | null {
  const tag = item.ImageTags?.Primary;
  if (!tag) return null;
  const params = new URLSearchParams({
    fillWidth: String(width),
    fillHeight: String(Math.round(width * 1.5)),
    quality: "90",
    tag,
  });
  return `/jf/Items/${item.Id}/Images/Primary?${params.toString()}`;
}

export function backdropUrl(item: MediaItem, width = 1920): string | null {
  const tag = item.BackdropImageTags?.[0];
  if (tag) {
    const params = new URLSearchParams({
      fillWidth: String(width),
      quality: "85",
      tag,
    });
    return `/jf/Items/${item.Id}/Images/Backdrop/0?${params.toString()}`;
  }
  // Fall back to the poster so a hero is never empty.
  const primary = item.ImageTags?.Primary;
  if (!primary) return null;
  return `/jf/Items/${item.Id}/Images/Primary?fillWidth=${width}&quality=85&tag=${primary}`;
}

export function formatRuntime(ticks?: number): string | null {
  if (!ticks) return null;
  const totalMinutes = Math.round(ticks / TICKS_PER_MS / 1000 / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** 0–100, for the resume bar on a poster. */
export function progressPercent(item: MediaItem): number {
  const pct = item.UserData?.PlayedPercentage;
  if (typeof pct === "number" && pct > 0) return Math.min(100, pct);
  const position = item.UserData?.PlaybackPositionTicks ?? 0;
  if (position > 0 && item.RunTimeTicks) {
    return Math.min(100, (position / item.RunTimeTicks) * 100);
  }
  return 0;
}

export function resumeSeconds(item: MediaItem): number {
  const ticks = item.UserData?.PlaybackPositionTicks ?? 0;
  return ticks > 0 ? Math.floor(ticks / TICKS_PER_MS / 1000) : 0;
}

/** Best-effort quality label from the media streams, e.g. "4K · HEVC". */
export function qualityLabel(item: MediaItem): string | null {
  const video = item.MediaSources?.[0]?.MediaStreams?.find((s) => s.Type === "Video");
  if (!video) return null;
  const height = video.Height ?? 0;
  const width = video.Width ?? 0;
  // Classified on width as well as height. A film shot in scope is letterboxed
  // into a shorter frame — Barbie is a full 1920x960 master — and a
  // height-only test filed every one of those as 720p, which was simply wrong
  // and made the library look worse than it is.
  const res =
    width >= 3200 || height >= 2000
      ? "4K"
      : width >= 1800 || height >= 1000
        ? "1080p"
        : width >= 1200 || height >= 700
          ? "720p"
          : width > 0
            ? "SD"
            : null;
  const codec = video.Codec?.toUpperCase();
  return [res, codec].filter(Boolean).join(" · ") || null;
}

/* ------------------------------------------------------------------ *
 * Smarter search
 * ------------------------------------------------------------------ */

export interface SearchMatch {
  item: MediaItem;
  /** Why this matched, shown to the user. */
  reason: string;
  /** Set when this match stands in for a whole grouped title, not one file — links to /collection/{groupId}. */
  groupId?: string;
  partsCount?: number;
  /** The series' own OMDb poster; overrides posterUrl(item) when set. Only present on a group match. */
  posterSrc?: string | null;
}

export interface SearchHit {
  id: string;
  name: string;
  year: number | null;
  poster: string | null;
  reason: string;
  href?: string;
  partsCount?: number;
}

/** Lightweight shape for the type-ahead dropdown. */
export function toSearchHit(match: SearchMatch): SearchHit {
  return {
    id: match.item.Id,
    name: match.item.Name,
    year: match.item.ProductionYear ?? null,
    poster: match.posterSrc !== undefined ? match.posterSrc : posterUrl(match.item, 120),
    reason: match.reason,
    href: match.groupId ? `/collection/${match.groupId}` : undefined,
    partsCount: match.partsCount,
  };
}

export interface CollapsedRow {
  /** One entry per real movie, plus one synthetic entry per group encountered (its first-seen member's slot). */
  items: MediaItem[];
  /** groupId (== the synthetic item's Id) -> /collection/{groupId}, for PosterCard's href override. */
  hrefs: Map<string, string>;
  /** groupId -> the series' own OMDb poster (or null if it has none yet), for PosterCard's posterSrc override. */
  posters: Map<string, string | null>;
  /** groupId -> episode count, for PosterCard's "N parts" badge. */
  partsCounts: Map<string, number>;
  /** groupId -> the show's real name, in case the synthetic item's own Name ever needs overriding too. */
  titles: Map<string, string>;
}

/**
 * Collapses any grouped TV episodes in a list down to one tile per show —
 * the same "N parts" tile Search and Browse already use — so a title list
 * assembled from raw Jellyfin items (each episode is its own "Movie" item
 * to Jellyfin; the grouping only exists in this app's own database) never
 * shows a show as ten separate, often mis-titled entries.
 *
 * Only the FIRST episode of a show encountered in the input list produces a
 * tile; every later episode from the same show is dropped rather than
 * turned into a duplicate tile — same reasoning as smartSearch's insertion-
 * time dedup.
 *
 * Deliberately NOT applied to "Continue watching": that row is about
 * resuming one specific episode's playback position, not browsing titles,
 * so collapsing it would replace a working "resume where I left off" link
 * with a link to the show's episode list instead. Apply this only to rows
 * that are genuinely "browse titles" — More like this, Recently added,
 * genre rows, a person's filmography, search.
 */
export function collapseEpisodeGroups(rawItems: MediaItem[]): CollapsedRow {
  const groupedPaths = getGroupedPathMap();
  const seriesPosters = getAllGroupSeriesPosters();

  const items: MediaItem[] = [];
  const hrefs = new Map<string, string>();
  const posters = new Map<string, string | null>();
  const partsCounts = new Map<string, number>();
  const titles = new Map<string, string>();
  const seenGroups = new Set<string>();

  for (const item of rawItems) {
    const g = item.Path ? groupedPaths.get(item.Path) : undefined;
    if (!g) {
      items.push(item);
      continue;
    }
    if (seenGroups.has(g.groupId)) continue;
    seenGroups.add(g.groupId);

    const full = getGroup(g.groupId);
    const name = full?.groupName ?? g.groupName;
    items.push({ Id: g.groupId, Name: name, Type: "Group" });
    hrefs.set(g.groupId, `/collection/${g.groupId}`);
    partsCounts.set(g.groupId, full?.paths.length ?? 1);
    posters.set(g.groupId, seriesPosters.get(g.groupId) ?? null);
    titles.set(g.groupId, name);
  }

  return { items, hrefs, posters, partsCounts, titles };
}

/**
 * Swaps a group's placeholder match (still carrying whichever member item
 * first matched) for the group's own name, poster and part count — so
 * "The Curse" reads as the show, not as episode 3 of it.
 */
function finalizeGroupMatches(matches: SearchMatch[]): SearchMatch[] {
  const seriesPosters = getAllGroupSeriesPosters();
  return matches.map((match) => {
    if (!match.groupId) return match;
    const full = getGroup(match.groupId);
    return {
      item: { Id: match.groupId, Name: full?.groupName ?? match.item.Name, Type: "Group" },
      reason: match.reason,
      groupId: match.groupId,
      partsCount: full?.paths.length,
      posterSrc: seriesPosters.get(match.groupId) ?? null,
    };
  });
}

/**
 * Search that also looks past the title.
 *
 * THIS IS THE ONLY SEARCH. The dropdown and the results page both call it, so
 * they cannot disagree — an earlier version had the type-ahead matching genres
 * while the results page matched titles only, which meant typing "comedy"
 * offered two films and then showed none when you pressed Enter.
 *
 * Jellyfin's `searchTerm` matches titles and little else, so "Margot Robbie" or
 * "animation" returns nothing even when the library obviously contains matches.
 * This runs the title search, then falls back to scanning the (small, already
 * fetched) catalogue for cast, genre, studio and year hits — and says which one
 * fired, because an unexplained result is confusing.
 *
 * The local scan is only reasonable because these libraries are hundreds of
 * items, not millions. At a larger scale this belongs in a real index.
 */
export async function smartSearch(
  session: ResolvedSession,
  query: string,
  limit = 8,
): Promise<SearchMatch[]> {
  const term = query.trim().toLowerCase();
  if (term.length < 2) return [];

  const [byTitle, everything] = await Promise.all([
    search(session, query).catch(() => []),
    // Same cap that used to silently truncate Browse — matched to the same
    // fix so a title past the old 400th slot isn't unfindable by fallback.
    getAllMovies(session, { limit: 2000 }).catch(() => []),
  ]);

  // Grouped episodes are deduped at insertion, not just in the final list:
  // otherwise a show with ten mis-matched episode files could fill the
  // entire result limit with copies of itself before any other title got a
  // slot — the same key groupId ends up landing in this map only once.
  const groupedPaths = getGroupedPathMap();
  const hits = new Map<string, SearchMatch>();
  const add = (item: MediaItem, reason: string) => {
    const g = item.Path ? groupedPaths.get(item.Path) : undefined;
    const key = g ? `group:${g.groupId}` : item.Id;
    if (hits.has(key) || hits.size >= limit) return;
    hits.set(key, { item, reason, groupId: g?.groupId });
  };

  for (const item of byTitle) add(item, "Title");

  if (hits.size < limit) {
    // Detail fields are not in the list payload, so cast matching needs a
    // second pass over the candidates only.
    for (const item of everything) {
      if (hits.size >= limit) break;

      if ((item.Genres ?? []).some((g) => g.toLowerCase().includes(term))) {
        add(item, `Genre: ${(item.Genres ?? []).find((g) => g.toLowerCase().includes(term))}`);
        continue;
      }
      if (String(item.ProductionYear ?? "") === term) {
        add(item, `Released ${item.ProductionYear}`);
        continue;
      }
      if ((item.Overview ?? "").toLowerCase().includes(term)) {
        add(item, "Mentioned in the synopsis");
      }
    }
  }

  // Cast is the expensive one — only fetched when nothing cheaper matched, and
  // only for a bounded number of items.
  if (hits.size === 0) {
    const [token, device] = creds(session);
    const candidates = everything.slice(0, 40);
    const detailed = await Promise.all(
      candidates.map((item) =>
        userFetch<MediaItem>(token, device, `/Items/${encodeURIComponent(item.Id)}`, {
          userId: session.jellyfinUserId,
          fields: "People",
        }).catch(() => null),
      ),
    );
    for (const item of detailed) {
      if (!item || hits.size >= limit) continue;
      const person = (item.People ?? []).find((p) => p.Name.toLowerCase().includes(term));
      if (person) add(item, `${person.Type === "Director" ? "Director" : "Cast"}: ${person.Name}`);
    }
  }

  return finalizeGroupMatches([...hits.values()]);
}

/* ------------------------------------------------------------------ *
 * People
 * ------------------------------------------------------------------ */

export interface Person {
  Id: string;
  Name: string;
  Overview?: string;
  PrimaryImageTag?: string;
  ImageTags?: Record<string, string>;
}

export async function getPerson(
  session: ResolvedSession,
  personId: string,
): Promise<Person | null> {
  const [token, device] = creds(session);
  try {
    return await userFetch<Person>(
      token,
      device,
      `/Items/${encodeURIComponent(personId)}`,
      { userId: session.jellyfinUserId, fields: "Overview" },
    );
  } catch {
    return null;
  }
}

/**
 * Everything in the library featuring this person.
 *
 * Jellyfin does the filtering with `personIds`, so this stays one request no
 * matter how large the library grows — which is the whole reason cast links are
 * cheap to offer.
 */
export async function getItemsByPerson(
  session: ResolvedSession,
  personId: string,
): Promise<MediaItem[]> {
  const [token, device] = creds(session);
  try {
    const data = await userFetch<ItemsResponse>(token, device, "/Items", {
      userId: session.jellyfinUserId,
      recursive: true,
      includeItemTypes: "Movie",
      personIds: personId,
      sortBy: "ProductionYear,SortName",
      sortOrder: "Descending",
      limit: 100,
      fields: LIST_FIELDS,
      enableImageTypes: "Primary,Backdrop",
    });
    return filterVisible(data?.Items ?? []);
  } catch {
    return [];
  }
}

/** Portrait URL for a person, routed through the proxy. */
export function personPhotoUrl(person: Person, size = 300): string | null {
  const tag = person.PrimaryImageTag ?? person.ImageTags?.Primary;
  if (!tag) return null;
  return `/jf/Items/${person.Id}/Images/Primary?fillWidth=${size}&fillHeight=${size}&quality=90&tag=${tag}`;
}
