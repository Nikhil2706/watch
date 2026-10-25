/**
 * The film pane's Subtitles list: every candidate OpenSubtitles has, best
 * guess first, for the curator to choose from. The single-click fetch used to
 * download one guess without showing anything (The Others, 2026-10-25). Pure,
 * so it is tested directly; subtitle-chooser.ts does the searching and writing.
 *
 * How the guess is made, strongest signal first:
 *   1. OpenSubtitles says the subtitle was timed against this exact video
 *      (the file's moviehash): it will be in sync.
 *   2. It was made for the same release as the file: the same release group
 *      ("-SPARKS", "[YTS.MX]"), or a release name mostly the same as the file
 *      name (source, resolution, group: "BluRay 1080p x264").
 *   3. Then trusted uploaders, plain before hearing-impaired, the better
 *      rated (with 3+ votes), and the most downloaded.
 */

import { releaseSignature, signatureSimilarity, type SubtitleCandidate } from "./subtitle-match.ts";

/** A release name this similar to the file's (word overlap, 0..1) counts as the same release. */
export const SAME_RELEASE_SIMILARITY = 0.6;

/** The release group a name ends with: "x264-SPARKS" -> "sparks", "[YTS.MX]" -> "ytsmx". */
export function releaseGroup(name: string | null | undefined): string | null {
  if (!name) return null;
  const stem = name.replace(/\.(srt|sub|ass|ssa|vtt|mp4|mkv|avi|m4v|mov|wmv|ts)$/i, "").trim();
  const bracket = /\[([^\]]+)\]\s*$/.exec(stem);
  const raw = bracket ? bracket[1]! : /-([A-Za-z0-9.]+)$/.exec(stem)?.[1];
  const group = raw?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return group.length >= 2 && !/^\d+$/.test(group) && !["x264", "x265", "h264", "h265", "aac", "dl"].includes(group) ? group : null;
}

export interface ReleaseMatch {
  /** Word overlap between the file name and the subtitle's release name, 0..1. */
  similarity: number;
  sameGroup: boolean;
  /** Either: taken to be made for this release. */
  sameRelease: boolean;
}

export function releaseMatch(videoFileName: string, c: SubtitleCandidate): ReleaseMatch {
  const theirs = c.release || c.fileName;
  const similarity = Math.max(
    signatureSimilarity(releaseSignature(videoFileName), releaseSignature(c.release)),
    signatureSimilarity(releaseSignature(videoFileName), releaseSignature(c.fileName)),
  );
  const group = releaseGroup(videoFileName);
  const sameGroup = !!group && (releaseGroup(c.release) === group || releaseGroup(c.fileName) === group || !!theirs?.toLowerCase().replace(/[^a-z0-9]/g, "").endsWith(group));
  return { similarity, sameGroup, sameRelease: sameGroup || similarity >= SAME_RELEASE_SIMILARITY };
}

export interface RankedChoice {
  candidate: SubtitleCandidate;
  match: ReleaseMatch;
  /** Why it is where it is, in words. */
  tags: string[];
}

export function rankChoices(candidates: readonly SubtitleCandidate[], videoFileName: string): RankedChoice[] {
  const rating = (c: SubtitleCandidate) => ((c.votes ?? 0) >= 3 ? (c.rating ?? 0) : 0);
  return candidates
    .map((candidate) => {
      const match = releaseMatch(videoFileName, candidate);
      return { candidate, match, tags: choiceTags(candidate, match) };
    })
    .sort(
      (a, b) =>
        Number(b.candidate.hashMatch) - Number(a.candidate.hashMatch) ||
        Number(b.match.sameRelease) - Number(a.match.sameRelease) ||
        Number(b.match.sameGroup) - Number(a.match.sameGroup) ||
        (a.match.sameRelease && b.match.sameRelease ? b.match.similarity - a.match.similarity : 0) ||
        Number(!!b.candidate.fromTrusted) - Number(!!a.candidate.fromTrusted) ||
        Number(a.candidate.hearingImpaired) - Number(b.candidate.hearingImpaired) ||
        rating(b.candidate) - rating(a.candidate) ||
        b.candidate.downloadCount - a.candidate.downloadCount,
    );
}

/** Short reasons to show beside a candidate. */
export function choiceTags(c: SubtitleCandidate, match?: ReleaseMatch): string[] {
  const tags: string[] = [];
  if (c.hashMatch) tags.push("synced to this file");
  if (match?.sameGroup) tags.push("same release group as your file");
  else if (match?.sameRelease) tags.push(`name matches your file (${Math.round(match.similarity * 100)}%)`);
  if (c.fromTrusted) tags.push("trusted uploader");
  if (c.hearingImpaired) tags.push("hearing impaired");
  if ((c.votes ?? 0) >= 3 && c.rating) tags.push(`rated ${c.rating}/10`);
  tags.push(`${c.downloadCount.toLocaleString("en-GB")} downloads`);
  return tags;
}

/**
 * Where a chosen subtitle is written, next to the video: "<video>.eng.srt",
 * or when that is taken (an existing subtitle is kept, never overwritten)
 * "<video>.2.eng.srt", ".3", ... Jellyfin reads each as another English track.
 */
export function chosenSubtitlePath(videoPath: string, exists: (path: string) => boolean): string {
  const dot = videoPath.lastIndexOf(".");
  const slash = videoPath.lastIndexOf("/");
  const base = dot > slash ? videoPath.slice(0, dot) : videoPath;
  if (!exists(`${base}.eng.srt`)) return `${base}.eng.srt`;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}.${n}.eng.srt`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error("This film already has 99 subtitle files.");
}
