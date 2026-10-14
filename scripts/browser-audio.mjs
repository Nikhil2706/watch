/**
 * Browser audio: a stereo AAC track added to films whose only sound is
 * something a browser cannot play (DTS, TrueHD, E-AC-3, AC-3, PCM...).
 *
 * Without one, Jellyfin re-encodes the sound live for every viewer, every
 * time ("Stop Making Sense (1984) Restored ... DTS"): CPU on the Mac, and a
 * film that would otherwise play straight off the drive. Adding the track
 * once, in the background, makes it direct-play for good.
 *
 * The new track goes FIRST among the audio tracks and is the default, since
 * a browser plays the default track and Jellyfin decides direct play from
 * it. Every original track is kept, after it, untouched; the video and
 * everything else is copied, never re-encoded.
 *
 * This file is the judgement and the ffmpeg command, kept apart from the
 * worker that runs them (media-worker.mjs) so they can be tested.
 */

/** Audio a browser plays as it is (and Jellyfin's browser profile allows). */
export const BROWSER_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

/** Video a browser decodes itself (src/lib/playback-fix.ts keeps the same list). */
export const BROWSER_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);

/** Containers the remux writes back into the same container type. */
export const REMUX_CONTAINERS = new Set([".mkv", ".mp4", ".m4v"]);

/**
 * The audio track a player starts with: the one marked default, else the
 * first. Jellyfin decides direct play from this one, so a film with a FLAC
 * or AAC track elsewhere (a stereo mix, a commentary) still has its sound
 * re-encoded live when its default track is DTS ("Stop Making Sense": DTS 5.1
 * default, FLAC and a commentary in AAC after it). Returns the position among
 * the audio tracks, or -1 when there is no sound.
 */
export function defaultAudio(streams) {
  const audio = (streams ?? []).filter((s) => s.codec_type === "audio");
  if (audio.length === 0) return -1;
  const flagged = audio.findIndex((s) => Number(s.disposition?.default) === 1);
  return flagged >= 0 ? flagged : 0;
}

/**
 * Whether a file needs a browser track: it has sound, and the track a player
 * starts with is one a browser can't play. `streams` is ffprobe's list
 * (codec_type, codec_name, disposition.default).
 * @returns {{ needed: boolean, reason: string }}
 */
export function needsBrowserAudio(streams, ext) {
  const audio = (streams ?? []).filter((s) => s.codec_type === "audio");
  const at = defaultAudio(streams);
  if (at < 0) return { needed: false, reason: "no sound" };
  // A picture a browser can't decode needs the full conversion (the Worker
  // tab's "Needs conversion"), which writes browser audio anyway; adding a
  // track first would be work thrown away.
  const video = (streams ?? []).find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const vcodec = String(video?.codec_name ?? "").toLowerCase();
  const tenBit = /10|12/.test(String(video?.pix_fmt ?? ""));
  if (video && (!BROWSER_VIDEO.has(vcodec) || (vcodec === "h264" && tenBit))) {
    return { needed: false, reason: "the video needs converting first (that adds browser audio too)" };
  }
  const main = audio[at];
  if (BROWSER_AUDIO.has(String(main.codec_name).toLowerCase())) {
    return { needed: false, reason: `its main track is already ${main.codec_name}` };
  }
  if (!REMUX_CONTAINERS.has(String(ext).toLowerCase())) {
    return { needed: false, reason: `${ext} files are left alone` };
  }
  return { needed: true, reason: `its main track is ${main.codec_name}` };
}

/**
 * The ffmpeg arguments: video first, then the new AAC track (made from the
 * main audio track, mixed to stereo), then every original audio track, then
 * subtitles (and, in Matroska, attachments). Metadata and chapters carried
 * over. The main track's language goes on the new one.
 */
export function remuxArgs(input, output, streams, ext) {
  const mkv = String(ext).toLowerCase() === ".mkv";
  const audio = (streams ?? []).filter((s) => s.codec_type === "audio");
  const main = Math.max(0, defaultAudio(streams));
  const lang = audio[main]?.tags?.language;
  const originals = audio.length;
  const args = [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    "-i", input,
    "-map", "0:v?",
    "-map", `0:a:${main}`,
    "-map", "0:a",
    "-map", "0:s?",
  ];
  if (mkv) args.push("-map", "0:t?");
  args.push(
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-c", "copy",
    "-c:a:0", "aac",
    "-ac:a:0", "2",
    "-b:a:0", "192k",
    "-metadata:s:a:0", "title=Stereo (AAC)",
  );
  if (lang) args.push("-metadata:s:a:0", `language=${lang}`);
  args.push("-disposition:a:0", "default");
  for (let i = 1; i <= originals; i += 1) args.push(`-disposition:a:${i}`, "0");
  // An MP4 is only remuxed when its subtitles are mov_text (see
  // mp4SubtitlesBlock), the one kind that copies back into MP4.
  if (!mkv) args.push("-movflags", "+faststart");
  args.push(output);
  return args;
}

/**
 * Whether the remuxed file is safe to put in place of the original: same
 * length (within a second), every original stream still there, and the new
 * first audio track is stereo AAC.
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyRemux(before, after) {
  const dur = (p) => Number(p?.format?.duration ?? 0);
  if (!after || !Array.isArray(after.streams)) return { ok: false, reason: "the new file cannot be read" };
  if (Math.abs(dur(before) - dur(after)) > 1) {
    return { ok: false, reason: `length changed (${dur(before).toFixed(1)}s to ${dur(after).toFixed(1)}s)` };
  }
  const kinds = (p, type) => p.streams.filter((s) => s.codec_type === type).length;
  for (const type of ["video", "subtitle"]) {
    if (kinds(after, type) < kinds(before, type)) return { ok: false, reason: `a ${type} track went missing` };
  }
  if (kinds(after, "audio") !== kinds(before, "audio") + 1) {
    return { ok: false, reason: "the audio tracks are not the originals plus one" };
  }
  const first = after.streams.find((s) => s.codec_type === "audio");
  if (String(first?.codec_name) !== "aac" || Number(first?.channels) !== 2) {
    return { ok: false, reason: "the first audio track is not stereo AAC" };
  }
  return { ok: true, reason: "ok" };
}

/** True while an MP4 has subtitles that would not survive a copy into MP4. */
export function mp4SubtitlesBlock(streams, ext) {
  if (String(ext).toLowerCase() === ".mkv") return false;
  return (streams ?? []).some((s) => s.codec_type === "subtitle" && s.codec_name !== "mov_text");
}
