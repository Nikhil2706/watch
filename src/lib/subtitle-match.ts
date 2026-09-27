/**
 * Choosing the subtitle for every episode of a season from the one a person
 * approved.
 *
 * Episode subtitles come in families: an uploader times a whole season against
 * one release ("Heroes.S01E01.HDTV.XviD-LOL", "...S01E02.HDTV.XviD-LOL"...), so
 * once one episode's subtitle is known to be right, the right one for the next
 * episode is the one from the same family. Two cheap signals say which family
 * a candidate is in — who uploaded it and its release name with the episode
 * number taken out — and OpenSubtitles adds a third: a moviehash match, meaning
 * the subtitle was timed against this exact video file.
 *
 * Pure, so the judgement is tested against real search results.
 */

export interface SubtitleCandidate {
  fileId: number;
  fileName: string | null;
  release: string | null;
  uploader: string | null;
  hearingImpaired: boolean;
  fps: number | null;
  downloadCount: number;
  /** OpenSubtitles says this subtitle was synced to this exact video file. */
  hashMatch: boolean;
}

/** The family signature of the approved episode's subtitle. */
export interface SubtitleFamily {
  uploader: string | null;
  release: string | null;
  fileName: string | null;
  hearingImpaired: boolean;
  fps: number | null;
}

/**
 * A release name with the episode taken out, so every episode of a family
 * normalises to the same string: "Heroes.S01E05.HDTV.XviD-LOL" and
 * "heroes.1x05.hdtv-lol" both lose their numbers and punctuation.
 */
export function releaseSignature(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .toLowerCase()
    // Subtitle or video extension: a video filename is compared too.
    .replace(/\.(srt|sub|ass|ssa|vtt|mp4|mkv|avi|m4v|mov|wmv|ts)$/, "")
    .replace(/s\d{1,2}\s*e\d{1,3}/g, " ")
    .replace(/\b\d{1,2}x\d{1,3}\b/g, " ")
    .replace(/\bs\d{1,2}eall\b/g, " ")
    .replace(/\bepisode\s*\d+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b\d{1,3}\b/g, " ") // a bare episode number left behind ("heroes 101")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(s.split(" ").filter((t) => t.length > 1));
}

/** Share of tokens two signatures have in common (Jaccard), 0..1. */
export function signatureSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export interface ScoredCandidate {
  candidate: SubtitleCandidate;
  score: number;
  why: string[];
}

/** Below this, no candidate is trusted enough to download on its own say-so. */
export const MIN_FAMILY_SCORE = 3;

export function scoreCandidate(
  c: SubtitleCandidate,
  family: SubtitleFamily,
  /** The episode's own video filename: a subtitle named for that release was made for it. */
  videoName?: string | null,
): ScoredCandidate {
  let score = 0;
  const why: string[] = [];
  if (videoName) {
    const own = Math.max(
      signatureSimilarity(releaseSignature(c.release), releaseSignature(videoName)),
      signatureSimilarity(releaseSignature(c.fileName), releaseSignature(videoName)),
    );
    if (own >= 0.99) {
      score += 3;
      why.push("named for this file's release");
    } else if (own >= 0.75) {
      score += 2;
      why.push("close to this file's release");
    }
  }
  if (family.uploader && c.uploader && c.uploader.toLowerCase() === family.uploader.toLowerCase()) {
    score += 3;
    why.push("same uploader");
  }
  const rel = Math.max(
    signatureSimilarity(releaseSignature(c.release), releaseSignature(family.release)),
    signatureSimilarity(releaseSignature(c.fileName), releaseSignature(family.fileName)),
  );
  if (rel >= 0.99) {
    score += 3;
    why.push("same release");
  } else if (rel >= 0.6) {
    score += 2 * rel;
    why.push("similar release");
  }
  if (c.hashMatch) {
    score += 3;
    why.push("synced to this file");
  }
  if (c.hearingImpaired === family.hearingImpaired) score += 0.5;
  if (family.fps && c.fps && Math.abs(family.fps - c.fps) < 0.05) score += 0.5;
  return { candidate: c, score, why };
}

/** The best candidate for an episode, or null when nothing is family enough. */
export function pickFromFamily(
  candidates: readonly SubtitleCandidate[],
  family: SubtitleFamily,
  videoName?: string | null,
): ScoredCandidate | null {
  const scored = candidates
    .map((c) => scoreCandidate(c, family, videoName))
    .sort((a, b) => b.score - a.score || b.candidate.downloadCount - a.candidate.downloadCount);
  const best = scored[0];
  return best && best.score >= MIN_FAMILY_SCORE ? best : null;
}

/**
 * How alike two subtitle files are, by what they say (0..1) — used once per
 * season, to find which search result the approved file actually is. Timing
 * and formatting are ignored: the same uploader's file is often re-saved or
 * lightly edited, but its words are the same.
 */
export function subtitleTextSimilarity(a: string, b: string): number {
  const lines = (s: string) =>
    new Set(
      s
        .replace(/\r/g, "")
        .split("\n")
        .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
        .map((l) => l.replace(/<[^>]+>|\{[^}]+\}/g, "").toLowerCase().replace(/[^a-z0-9']+/g, " ").trim())
        .filter((l) => l.length > 2),
    );
  const la = lines(a);
  const lb = lines(b);
  if (la.size === 0 || lb.size === 0) return 0;
  let shared = 0;
  for (const l of la) if (lb.has(l)) shared++;
  return shared / Math.min(la.size, lb.size);
}
