import "server-only";

import { asRow, getDb } from "./db";
import type { MediaItem } from "./media";
import { isPictureCodec, type PictureTrack } from "./picture-subtitles";

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

/**
 * ISO codes to names a person recognises.
 *
 * Jellyfin's own DisplayTitle reads "English - SUBRIP - External", which tells
 * the viewer three things they do not care about and buries the one they do.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", eng: "English",
  hi: "Hindi", hin: "Hindi",
  ta: "Tamil", tam: "Tamil",
  te: "Telugu", tel: "Telugu",
  bn: "Bengali", ben: "Bengali",
  mr: "Marathi", mar: "Marathi",
  kn: "Kannada", kan: "Kannada",
  ml: "Malayalam", mal: "Malayalam",
  gu: "Gujarati", guj: "Gujarati",
  pa: "Punjabi", pan: "Punjabi",
  ur: "Urdu", urd: "Urdu",
  fr: "French", fre: "French", fra: "French",
  de: "German", ger: "German", deu: "German",
  es: "Spanish", spa: "Spanish",
  ja: "Japanese", jpn: "Japanese",
  ko: "Korean", kor: "Korean",
  zh: "Chinese", chi: "Chinese", zho: "Chinese",
  it: "Italian", ita: "Italian",
  pt: "Portuguese", por: "Portuguese",
  ru: "Russian", rus: "Russian",
  fa: "Persian", per: "Persian", fas: "Persian",
  sv: "Swedish", swe: "Swedish",
  da: "Danish", dan: "Danish",
  nl: "Dutch", dut: "Dutch", nld: "Dutch",
  pl: "Polish", pol: "Polish",
  cs: "Czech", cze: "Czech", ces: "Czech",
};

/** "English" for "eng"/"en"; undefined for a code this list doesn't know. */
export function languageName(code: string | null | undefined): string | undefined {
  return code ? LANGUAGE_NAMES[code.toLowerCase()] : undefined;
}

/** "English", "English (SDH)", "English (Forced)". */
function readableLabel(stream: {
  Language?: string;
  Title?: string;
  DisplayTitle?: string;
  IsForced?: boolean;
  IsHearingImpaired?: boolean;
}): string {
  const code = (stream.Language ?? "").toLowerCase();
  const base =
    LANGUAGE_NAMES[code] ??
    // Fall back to a title the uploader set, then to the raw code, then to
    // something honest rather than an empty chip.
    stream.Title ??
    // "und" is the container's own word for "not set".
    (code && code !== "und" ? code.toUpperCase() : "Unlabelled");

  const flags: string[] = [];
  if (stream.IsHearingImpaired) flags.push("SDH");
  if (stream.IsForced) flags.push("Forced");
  return flags.length > 0 ? `${base} (${flags.join(", ")})` : base;
}

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

/** Languages read from the text of a file's untagged built-in tracks, by stream index. */
function trackLanguages(path: string): Map<number, string> {
  const rows = getDb()
    .prepare("SELECT stream_index, language FROM subtitle_track_language WHERE path = ?")
    .all(path) as Array<{ stream_index: number; language: string }>;
  return new Map(rows.map((r) => [r.stream_index, r.language]));
}

export function setTrackLanguages(entries: ReadonlyArray<{ path: string; index: number; language: string }>): number {
  const put = getDb().prepare(
    `INSERT INTO subtitle_track_language (path, stream_index, language, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(path, stream_index) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  for (const e of entries) put.run(e.path, e.index, e.language, now);
  return entries.length;
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
 * The picture subtitles (DVDSUB, PGS) of an item, which only show burned into
 * the picture (picture-subtitles.ts). Listed apart from listSubtitles because
 * choosing one means a new stream, not a <track>.
 */
export function listPictureSubtitles(item: MediaItem): PictureTrack[] {
  const source = item.MediaSources?.[0];
  return (source?.MediaStreams ?? [])
    .filter((stream) => stream.Type === "Subtitle" && isPictureCodec(stream.Codec))
    .map((stream) => ({
      index: stream.Index,
      label: readableLabel(stream),
      language: stream.Language ?? null,
      isForced: Boolean(stream.IsForced),
    }));
}

/**
 * Every selectable subtitle track for an item, ordered for a picker.
 *
 * Image-based tracks (PGS, VOBSUB) are excluded: they cannot be rendered as
 * text by a browser, and offering them would produce a track that silently does
 * nothing when chosen. listPictureSubtitles has them.
 */
export function listSubtitles(item: MediaItem): SubtitleTrack[] {
  const source = item.MediaSources?.[0];
  if (!source) return [];

  const recommendedIndex = getRecommendedIndex(item.Id);
  const found = item.Path ? trackLanguages(item.Path) : new Map<number, string>();

  const tracks = (source.MediaStreams ?? [])
    .filter((stream) => stream.Type === "Subtitle")
    .filter((stream) => !isPictureCodec(stream.Codec))
    .map((stream) => {
      // A built-in track with no tag of its own takes the language read from
      // its text (subtitle_track_language); a tag the file has always wins.
      const own = stream.Language && stream.Language.toLowerCase() !== "und" ? stream.Language : null;
      const read = !own && !stream.IsExternal ? (found.get(stream.Index) ?? null) : null;
      const language = own ?? read;
      return {
        index: stream.Index,
        label: readableLabel(read ? { ...stream, Language: read } : stream),
        language,
        isExternal: Boolean(stream.IsExternal),
        isForced: Boolean(stream.IsForced),
        isDefault: Boolean(stream.IsDefault),
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
