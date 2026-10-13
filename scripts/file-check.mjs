/**
 * Is a film's file intact enough to play?
 *
 * A browser's player stops dead on data it cannot decode. "Dashcam" (2021)
 * did, twice, 64 seconds in: its audio had 9,891 unreadable packets and its
 * video had broken frames, from a bad download. Nothing noticed, because
 * Jellyfin only reads a file's headers, and those were fine.
 *
 * So every file is read through once with ffmpeg, twice over: the audio is
 * decoded in full (cheap: under a minute for a feature), and the video is
 * read packet by packet without decoding it (decoding two hours of video is
 * the expensive part, and a broken download shows in the packets). Ten
 * healthy files from this library, of every kind in it, gave no message at
 * all from either pass, so anything ffmpeg says is worth counting.
 *
 * This file is the judgement, kept apart from the worker that runs ffmpeg so
 * that it can be tested: what counts as an error line, and how many make a
 * file "damaged" (kept off the site until replaced or allowed) rather than
 * "minor" (noted, still shown).
 */

/** Lines of ffmpeg's `-v error` output that report unreadable data. */
export function countErrors(stderr) {
  let n = 0;
  for (const line of String(stderr ?? "").split("\n")) {
    if (/error|invalid|corrupt|missing picture|non-existing|out of range|truncat/i.test(line)) n += 1;
  }
  return n;
}

/**
 * One or two messages are usually a file cut a frame short at the very end,
 * which plays. Three is where it stops being a tail and starts being a hole.
 */
export const DAMAGED_FROM = 3;

/**
 * @param {{ audioErrors: number, videoErrors: number, unreadable?: boolean }} r
 * @returns {{ verdict: "ok" | "minor" | "damaged", detail: string }}
 */
export function judge(r) {
  // An empty or cut-off file: a download that has not finished, or a copy that
  // failed. Off the site either way; it is read again when the file changes.
  if (r.unreadable) return { verdict: "damaged", detail: "The file cannot be opened: it is empty or incomplete (still copying, or a failed copy)." };
  const parts = [];
  const n = (count) => count.toLocaleString("en-GB");
  if (r.audioErrors > 0) parts.push(`${n(r.audioErrors)} unreadable stretch${r.audioErrors === 1 ? "" : "es"} of sound`);
  if (r.videoErrors > 0) parts.push(`${n(r.videoErrors)} broken piece${r.videoErrors === 1 ? "" : "s"} of picture`);
  if (parts.length === 0) return { verdict: "ok", detail: "" };
  const worst = Math.max(r.audioErrors, r.videoErrors);
  return { verdict: worst >= DAMAGED_FROM ? "damaged" : "minor", detail: parts.join(", ") };
}

/**
 * Too fresh to judge: written to in the last ten minutes, so quite possibly
 * still arriving. It is looked at on a later round.
 */
export function isStillArriving(mtimeMs, now) {
  return now - mtimeMs < 10 * 60 * 1000;
}

/** Has the file changed since it was checked? A replaced file is checked again. */
export function isStale(row, size, mtimeMs) {
  return !row || Number(row.size) !== size || Math.abs(Number(row.mtime_ms) - Math.round(mtimeMs)) > 2000;
}
