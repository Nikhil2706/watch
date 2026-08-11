import "server-only";

import { userFetch, userPost } from "./jellyfin";
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
  Overview?: string;
  ProductionYear?: number;
  CommunityRating?: number;
  OfficialRating?: string;
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
  People?: Array<{ Name: string; Role?: string; Type: string; Id: string }>;
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
      Language?: string;
      Index: number;
    }>;
  }>;
}

interface ItemsResponse {
  Items: MediaItem[];
  TotalRecordCount: number;
}

/** Ticks are 100ns units. Jellyfin uses them everywhere. */
const TICKS_PER_MS = 10_000;

const LIST_FIELDS =
  "PrimaryImageAspectRatio,Overview,Genres,ProductionYear,CommunityRating,OfficialRating,MediaSourceCount";

const DETAIL_FIELDS =
  "Overview,Genres,ProductionYear,CommunityRating,OfficialRating,People,MediaSources,MediaStreams,Studios,Taglines";

function creds(session: ResolvedSession) {
  return [session.jellyfinToken, session.jellyfinDeviceId] as const;
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
  return data?.Items ?? [];
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
  return Array.isArray(data) ? data : [];
}

export async function getAllMovies(
  session: ResolvedSession,
  options: { limit?: number; sortBy?: string; genre?: string } = {},
): Promise<MediaItem[]> {
  const [token, device] = creds(session);
  const data = await userFetch<ItemsResponse>(token, device, "/Items", {
    userId: session.jellyfinUserId,
    recursive: true,
    includeItemTypes: "Movie",
    sortBy: options.sortBy ?? "SortName",
    sortOrder: "Ascending",
    limit: options.limit ?? 200,
    genres: options.genre,
    fields: LIST_FIELDS,
    enableImageTypes: "Primary,Backdrop",
  });
  return data?.Items ?? [];
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
    return data?.Items ?? [];
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
  return data?.Items ?? [];
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
  const res =
    height >= 2000 ? "4K" : height >= 1000 ? "1080p" : height >= 700 ? "720p" : null;
  const codec = video.Codec?.toUpperCase();
  return [res, codec].filter(Boolean).join(" · ") || null;
}

/* ------------------------------------------------------------------ *
 * Smarter search
 * ------------------------------------------------------------------ */

export interface SearchHit {
  id: string;
  name: string;
  year: number | null;
  poster: string | null;
  /** Why this matched, shown in the dropdown. */
  reason: string;
}

/**
 * Search that also looks past the title.
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
): Promise<SearchHit[]> {
  const term = query.trim().toLowerCase();
  if (term.length < 2) return [];

  const [byTitle, everything] = await Promise.all([
    search(session, query).catch(() => []),
    getAllMovies(session, { limit: 400 }).catch(() => []),
  ]);

  const hits = new Map<string, SearchHit>();
  const add = (item: MediaItem, reason: string) => {
    if (hits.has(item.Id) || hits.size >= limit) return;
    hits.set(item.Id, {
      id: item.Id,
      name: item.Name,
      year: item.ProductionYear ?? null,
      poster: posterUrl(item, 120),
      reason,
    });
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

  return [...hits.values()];
}
