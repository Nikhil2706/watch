/**
 * Where a stream with a picture subtitle burned in actually begins.
 *
 * Jellyfin burns a DVD/Blu-ray subtitle in with ffmpeg's sub2video, which
 * produces no frames until the subtitle track has something to show. So a
 * stream started (or restarted by a seek) part-way through begins at the next
 * subtitle line, not where it was asked to: on 2026-11-02 Angel asked for at
 * 30 s had video from 39.6 s, and the player waited at 30 s for frames that
 * would never come — the episode "reloaded and is not playing".
 *
 * The gap has, by definition, no subtitle in it, so jumping it skips no
 * dialogue the viewer chose to read. Only a gap ahead of the playhead and
 * within MAX_GAP_SECONDS is jumped: a longer one is not this.
 *
 * Pure, so it is tested directly; Player.tsx polls it while a picture
 * subtitle is burned in.
 */

export const MAX_GAP_SECONDS = 90;

/** HTMLMediaElement.HAVE_FUTURE_DATA: enough to play on from here. */
const HAVE_FUTURE_DATA = 3;

export interface MediaSnapshot {
  currentTime: number;
  readyState: number;
  /** The buffered ranges, [start, end] seconds, in order. */
  buffered: ReadonlyArray<readonly [number, number]>;
}

/** The time to move to, or null to leave the player alone. */
export function burnedStartJump(media: MediaSnapshot): number | null {
  if (media.readyState >= HAVE_FUTURE_DATA) return null;
  const t = media.currentTime;
  if (media.buffered.some(([start, end]) => start <= t && t < end)) return null;
  const ahead = media.buffered.find(([start]) => start > t);
  if (!ahead || ahead[0] - t > MAX_GAP_SECONDS) return null;
  // Just inside the range, so the player lands on a frame it has.
  return Math.round((ahead[0] + 0.05) * 1000) / 1000;
}
