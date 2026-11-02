/**
 * Picture subtitles: DVD and Blu-ray tracks stored as images (DVDSUB, PGS),
 * which no browser can draw. Jellyfin can only show them by burning one into
 * the picture while it transcodes.
 *
 * Left to itself it burns in whichever track the file marks as default. On
 * 2026-11-02 that was Danish, on every Angel episode, with the English track
 * beside it unreachable: the menu leaves picture tracks out (subtitles.ts), so
 * the viewer could neither turn Danish off nor choose English.
 *
 * So the site chooses, as it does for text tracks: a picture track is burned
 * in only when there is no text subtitle to show instead, and then the
 * English one; or the one the viewer picked in the menu (?sub= on /watch).
 *
 * Pure, so it is tested directly.
 */

/** Jellyfin's names for image-based subtitle codecs. */
const PICTURE_CODECS = new Set(["pgssub", "pgs", "dvdsub", "dvbsub", "vobsub", "hdmv_pgs_subtitle"]);

export function isPictureCodec(codec: string | null | undefined): boolean {
  return PICTURE_CODECS.has((codec ?? "").toLowerCase());
}

export interface PictureTrack {
  index: number;
  label: string;
  language: string | null;
  isForced: boolean;
}

/** What the viewer asked for: a stream index, "off", or nothing (use the default). */
export type SubtitleRequest = number | "off" | null;

/** Reads ?sub= from /watch: a stream index or "off"; anything else is no request. */
export function parseSubtitleRequest(value: string | string[] | undefined): SubtitleRequest {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "off") return "off";
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function isEnglish(language: string | null): boolean {
  const l = (language ?? "").toLowerCase();
  return l === "eng" || l === "en" || l.startsWith("en-");
}

/**
 * Which picture track to burn in, or null for none.
 *
 * `textDefault` is whether a text subtitle will be switched on (subtitles.ts
 * defaultTrack): a text track is better in every way — sharper, and no
 * transcode just for it — so none is burned in beside one.
 */
export function choosePictureBurn(input: {
  pictures: readonly PictureTrack[];
  textDefault: boolean;
  requested: SubtitleRequest;
}): number | null {
  const { pictures, textDefault, requested } = input;
  if (requested === "off") return null;
  if (typeof requested === "number") {
    // A text track's index (chosen in the menu) is not burned: it is shown as text.
    return pictures.some((p) => p.index === requested) ? requested : null;
  }
  if (textDefault) return null;
  const english =
    pictures.find((p) => isEnglish(p.language) && !p.isForced) ?? pictures.find((p) => isEnglish(p.language));
  return english?.index ?? null;
}
