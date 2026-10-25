/**
 * "Shift every episode by this much": after syncing one episode's subtitle,
 * the same shift for the show's other episodes. Pure, so it is tested
 * directly; the sync screen and subtitle-sync.ts use it.
 *
 * Which files are ticked by default: the ones named like the file just synced
 * (the part after the video's own name: ".eng.srt", ".2.eng.srt"). A season of
 * subtitles from one uploader is usually off by the same amount; a file from
 * somewhere else, named differently, probably isn't, so it is offered unticked.
 * An English tag is taken as no tag (".srt" is ".eng.srt"), since Jellyfin
 * reads both as English: an episode synced as "x.srt" still finds its
 * neighbours' "y.eng.srt". Where an episode has both the exact name and an
 * alike one, only the exact one is ticked.
 */

/** What a subtitle file's name adds to its video's: "Show.S01E02.mkv" + "Show.S01E02.eng.srt" -> ".eng.srt". */
export function subtitleSuffix(videoPath: string, subtitleName: string): string {
  const file = videoPath.split("/").pop() ?? videoPath;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return subtitleName.startsWith(stem) ? subtitleName.slice(stem.length).toLowerCase() : subtitleName.toLowerCase();
}

/** A suffix with any English tag dropped: ".eng.srt", ".en.srt" and ".srt" are alike. */
export function alikeSuffix(suffix: string): string {
  return suffix.toLowerCase().replace(/\.(?:eng|en|english)(?=\.[a-z0-9]+$)/, "");
}

export interface EpisodeFiles {
  itemId: string;
  path: string;
  label: string;
  files: string[];
}

/** itemId + file name -> ticked, for every other episode's files. */
export function defaultShiftPicks(
  current: { videoPath: string; name: string },
  others: readonly EpisodeFiles[],
): Record<string, boolean> {
  const want = subtitleSuffix(current.videoPath, current.name);
  const picks: Record<string, boolean> = {};
  for (const e of others) {
    const exact = e.files.some((f) => subtitleSuffix(e.path, f) === want);
    for (const f of e.files) {
      const suffix = subtitleSuffix(e.path, f);
      picks[`${e.itemId}\n${f}`] = exact ? suffix === want : alikeSuffix(suffix) === alikeSuffix(want);
    }
  }
  return picks;
}
