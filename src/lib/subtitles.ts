import "server-only";

import { asRow, getDb } from "./db";
import type { MediaItem } from "./media";

/**
 * Subtitle track selection.
 *
 * These sources carry a lot of tracks — 43 on one film — so "show all available
 * subtitles" needs an order and a default, or the picker is unusable. The order
 * is: the admin's recommendation, then English, then everything else.
 */

export interface SubtitleTrack {
  index: number;
  label: string;
  language: string | null;
  isExternal: boolean;
  isForced: boolean;
  isDefault: boolean;
  /** Always a /jf/* URL, so the browser fetches it through the proxy. */
  url: string;
  recommended: boolean;
}

const ENGLISH = new Set(["en", "eng", "english"]);

function isEnglish(language: string | null | undefined): boolean {
  return language ? ENGLISH.has(language.toLowerCase()) : false;
}

export interface SubtitlePref {
  jellyfin_item_id: string;
  stream_index: number;
  label: string | null;
  language: string | null;
  set_by: string;
  created_at: number;
}

export function getRecommendedIndex(itemId: string): number | null {
  const row = asRow<SubtitlePref>(
    getDb().prepare("SELECT * FROM subtitle_prefs WHERE jellyfin_item_id = ?").get(itemId),
  );
  return row ? row.stream_index : null;
}

export function setRecommended(input: {
  itemId: string;
  streamIndex: number;
  label: string | null;
  language: string | null;
  setBy: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO subtitle_prefs (jellyfin_item_id, stream_index, label, language, set_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(jellyfin_item_id) DO UPDATE SET
         stream_index = excluded.stream_index,
         label        = excluded.label,
         language     = excluded.language,
         set_by       = excluded.set_by,
         created_at   = excluded.created_at`,
    )
    .run(
      input.itemId,
      input.streamIndex,
      input.label,
      input.language,
      input.setBy,
      Date.now(),
    );
}

export function clearRecommended(itemId: string): void {
  getDb().prepare("DELETE FROM subtitle_prefs WHERE jellyfin_item_id = ?").run(itemId);
}

/**
 * Every selectable subtitle track for an item, ordered for a picker.
 *
 * Image-based tracks (PGS, VOBSUB) are excluded: they cannot be rendered as
 * text by a browser, and offering them would produce a track that silently does
 * nothing when chosen.
 */
export function listSubtitles(item: MediaItem): SubtitleTrack[] {
  const source = item.MediaSources?.[0];
  if (!source) return [];

  const recommendedIndex = getRecommendedIndex(item.Id);

  const tracks = (source.MediaStreams ?? [])
    .filter((stream) => stream.Type === "Subtitle")
    .filter((stream) => {
      const codec = (stream.Codec ?? "").toLowerCase();
      return !["pgssub", "pgs", "dvdsub", "dvbsub", "vobsub", "hdmv_pgs_subtitle"].includes(codec);
    })
    .map((stream) => {
      const language = stream.Language ?? null;
      return {
        index: stream.Index,
        label:
          stream.DisplayTitle ??
          [language ?? "Unknown", stream.Codec].filter(Boolean).join(" · "),
        language,
        isExternal: Boolean((stream as { IsExternal?: boolean }).IsExternal),
        isForced: Boolean((stream as { IsForced?: boolean }).IsForced),
        isDefault: Boolean((stream as { IsDefault?: boolean }).IsDefault),
        // Jellyfin transcodes any text subtitle format to WebVTT on request,
        // which is the only thing a <track> element understands.
        url: `/jf/Videos/${item.Id}/${source.Id}/Subtitles/${stream.Index}/Stream.vtt`,
        recommended: stream.Index === recommendedIndex,
      };
    });

  // Recommended first, then English, then the rest — each group keeping the
  // order Jellyfin reported.
  return tracks.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    const aEn = isEnglish(a.language);
    const bEn = isEnglish(b.language);
    if (aEn !== bEn) return aEn ? -1 : 1;
    return 0;
  });
}

/**
 * The track to switch on automatically.
 *
 * Admin's pick wins. Failing that, the first English track — this library is
 * for an English-speaking audience, and defaulting to nothing means everyone
 * hunts through the menu on every film.
 */
export function defaultTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  return (
    tracks.find((t) => t.recommended) ??
    tracks.find((t) => isEnglish(t.language) && !t.isForced) ??
    tracks.find((t) => isEnglish(t.language)) ??
    null
  );
}
