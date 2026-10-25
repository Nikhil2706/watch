/**
 * Subtitles for a film kept in several files (Out 1: one 743-minute film in
 * eight). A subtitle made for the whole film is one file; part 3's lines start
 * hours in. Knowing each part's length, part k is the stretch of the film
 * after the parts before it: its lines, moved to start at 0. Pure, so it is
 * tested directly; subtitle-parts-apply.ts reads the parts and writes the files.
 *
 * Releases cut their parts in slightly different places (a recap, a title
 * card), so a part can still be a few seconds off: that is what the sync
 * screen and "shift every part" are for.
 */

import type { Cue } from "./srt-timing.ts";

/** Each part's own subtitle lines: the whole film's, cut at the parts' lengths. */
export function splitAcrossParts(cues: readonly Cue[], partDurationsMs: readonly number[]): Cue[][] {
  const starts: number[] = [];
  let at = 0;
  for (const d of partDurationsMs) {
    starts.push(at);
    at += d;
  }
  const parts: Cue[][] = partDurationsMs.map(() => []);
  for (const cue of cues) {
    // The part this line starts in; one starting after the last part's end
    // (the film ran longer than its files add up to) goes to the last part.
    let k = starts.findIndex((s, i) => cue.startMs >= s && (i === starts.length - 1 || cue.startMs < starts[i + 1]!));
    if (k === -1) k = 0;
    const offset = starts[k]!;
    parts[k]!.push({ ...cue, startMs: cue.startMs - offset, endMs: cue.endMs - offset });
  }
  return parts.map((list) => list.map((c, i) => ({ ...c, index: i + 1 })));
}

/**
 * Whether an upload already comes split one file per part ("CD1", "CD2"...):
 * then part k takes file k as it is, rather than a whole-film file cut up.
 */
export function uploadFitsParts(fileCount: number, partCount: number): boolean {
  return partCount > 1 && fileCount === partCount;
}

/** The part a file name says it is: "EP3", "Part 3", "part3", "CD3", "pt.3"; null when it says none. */
export function partNumberIn(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /(?:^|[^a-z])(?:ep(?:isode)?|part|pt|cd|disc|reel)[\s._-]*0*(\d{1,2})(?!\d)/i.exec(name);
  return m ? Number(m[1]) : null;
}

/** An upload's files in part order: by the part number in each name, else as given. */
export function orderUploadFiles<T extends { fileName: string | null }>(files: readonly T[]): T[] {
  const numbered = files.map((f, i) => ({ f, i, n: partNumberIn(f.fileName) }));
  if (numbered.some((x) => x.n === null) || new Set(numbered.map((x) => x.n)).size !== files.length) return [...files];
  return numbered.sort((a, b) => a.n! - b.n!).map((x) => x.f);
}

/**
 * What an upload can do for a film in parts: "split" (one file per part),
 * "whole" (one file for the whole film, to be cut), "onePart" (one file for
 * one part only: "Out.1.1971.Part7"), or "mismatch" (several files, not one per part).
 */
export function uploadKind(
  upload: { release: string | null; fileName: string | null; files?: ReadonlyArray<{ fileName: string | null }> },
  partCount: number,
): { kind: "split" | "whole" | "onePart" | "mismatch"; part?: number } {
  const count = upload.files?.length ?? 1;
  if (uploadFitsParts(count, partCount)) return { kind: "split" };
  if (count > 1) return { kind: "mismatch" };
  const part = partNumberIn(upload.files?.[0]?.fileName ?? upload.fileName) ?? partNumberIn(upload.release);
  return part !== null && partCount > 1 ? { kind: "onePart", part } : { kind: "whole" };
}

/** "1:02:03" for a part's length in the panel. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
