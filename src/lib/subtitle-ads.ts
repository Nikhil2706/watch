/**
 * Subtitle files from release groups and subtitle sites carry their own ads
 * as cues: "Official YIFY movies site: YTS.BZ" over the opening shot,
 * "Advertise your product or brand here" from OpenSubtitles. They are timed
 * like dialogue, so the player shows them like dialogue.
 *
 * Only whole cues go, and only when their text names one of these sources or
 * uses one of their stock phrases. Kept narrow on purpose: a line of real
 * dialogue that happens to say "subtitles" stays.
 */
const AD_PATTERNS: RegExp[] = [
  /\byts\.(?:mx|am|ag|lt|bz|rs|pm|do)\b/i,
  /\byify\b/i,
  /opensubtitles/i,
  /\bsubscene\b/i,
  /\baddic7ed\b/i,
  /\bpodnapisi\b/i,
  /advertise your product or brand/i,
  /become (?:a )?vip member/i,
  /^\s*(?:english\s+)?subtitles?\s+(?:by|ripped by|synced by)\b/im,
  /^\s*(?:sync(?:ed)?|synced and corrected|sync and corrections?|corrected)\s+by\b/im,
];

export function isAdCue(text: string): boolean {
  return AD_PATTERNS.some((pattern) => pattern.test(text));
}

/** A WebVTT document with its ad cues removed; anything else comes back as it was. */
export function stripSubtitleAds(vtt: string): string {
  if (!/^﻿?WEBVTT/.test(vtt)) return vtt;
  const blocks = vtt.split(/\r?\n\r?\n/);
  const kept = blocks.filter((block) => {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex((line) => line.includes("-->"));
    if (timing < 0) return true; // header, NOTE, STYLE, REGION
    return !isAdCue(lines.slice(timing + 1).join("\n"));
  });
  return kept.length === blocks.length ? vtt : kept.join("\n\n");
}
