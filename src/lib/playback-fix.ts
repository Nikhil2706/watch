/**
 * What, if anything, a file needs before a browser can play it without Jellyfin
 * re-encoding it live. Used by the Worker tab's lists ("Needs conversion",
 * "Needs browser audio").
 *
 * It mirrors what actually happens at play time (media.ts asks Jellyfin with
 * browserProfile and plays the original whenever Jellyfin says it can play or
 * stream it as it is), not a narrower idea of a "perfect" file: an .mkv, or a
 * 4K H.264, plays as it is and needs nothing. The old rule ("anything not an
 * .mp4 with H.264 at most 1920 wide") listed 1,052 of 1,810 films on
 * 2026-10-15; only 447 needed their video converted, and 250 only needed a
 * browser audio track, which the worker adds in minutes without touching the
 * picture.
 */

/** Video a browser decodes itself (and browserProfile lets Jellyfin send as it is). */
const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
/** Audio a browser plays (scripts/browser-audio.mjs keeps the same list and the same "main track" rule). */
const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

const VIDEO_NAMES: Record<string, string> = {
  mpeg4: "MPEG-4 Part 2 (DivX/Xvid) video",
  msmpeg4v3: "old Microsoft MPEG-4 video",
  msmpeg4v2: "old Microsoft MPEG-4 video",
  hevc: "HEVC (H.265) video",
  mpeg2video: "MPEG-2 video",
  vc1: "VC-1 video",
  wmv3: "WMV video",
};

const AUDIO_NAMES: Record<string, string> = {
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus (E-AC-3)",
  dts: "DTS",
  truehd: "Dolby TrueHD",
};

export interface StreamInfo {
  Type?: string;
  Codec?: string | null;
  BitDepth?: number | null;
  IsDefault?: boolean | null;
}

export type PlaybackFix =
  | { fix: "convert"; reason: string }
  | { fix: "audio"; reason: string }
  | null;

export function playbackFix(streams: readonly StreamInfo[] | undefined): PlaybackFix {
  const all = streams ?? [];
  const video = all.find((s) => s.Type === "Video");
  const codec = (video?.Codec ?? "").toLowerCase();
  // Nothing Jellyfin probed as video: nothing this can judge, so not listed.
  if (!codec) return null;
  const tenBit = (video?.BitDepth ?? 8) > 8;
  if (!BROWSER_VIDEO.has(codec) || (codec === "h264" && tenBit)) {
    const name = codec === "h264" ? "10-bit H.264 video" : VIDEO_NAMES[codec] ?? `${codec.toUpperCase()} video`;
    return { fix: "convert", reason: tenBit && codec !== "h264" ? `10-bit ${name}` : name };
  }
  // The track a player starts with (default, else first) is what Jellyfin
  // decides from: a FLAC stereo mix or an AAC commentary further down doesn't
  // stop a DTS main track being re-encoded live.
  const audio = all.filter((s) => s.Type === "Audio");
  if (audio.length === 0) return null;
  const main = audio.find((s) => s.IsDefault) ?? audio[0];
  const codecName = (main?.Codec ?? "").toLowerCase();
  if (BROWSER_AUDIO.has(codecName)) return null;
  return { fix: "audio", reason: `main sound track is ${AUDIO_NAMES[codecName] ?? codecName.toUpperCase()}` };
}
