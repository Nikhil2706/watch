/**
 * The judgement behind "Find matching subtitles" for a show, with every
 * outside call handed in, so it is tested without OpenSubtitles, Jellyfin or
 * a disk (subtitle-series.ts does the wiring).
 *
 * Only episodes with no subtitle at all are planned for. A file with a
 * built-in track already plays with subtitles; adding a download next to it
 * would spend quota on a problem nobody has.
 *
 * For those, in order:
 *   1. Learn from a reference: an episode whose subtitle a person can be taken
 *      to have approved. An external file next to the video first (somebody
 *      put it there), else a built-in text track (it shipped with the
 *      release). Its words identify which OpenSubtitles upload it is, and the
 *      missing episodes get that uploader's/release's files (subtitle-match.ts).
 *   2. Without a usable reference, or when the family has no file for an
 *      episode: the subtitle OpenSubtitles says was timed against this exact
 *      video (moviehash), then the best-rated release for that episode.
 * Every pick says which of these chose it.
 */

import { pickFromFamily, subtitleTextSimilarity, type SubtitleCandidate, type SubtitleFamily } from "./subtitle-match.ts";

/** Below this similarity, a downloaded candidate is not the reference's file. */
export const MIN_TEXT_SIMILARITY = 0.5;
/** Most downloads spent identifying the reference. Search is free; downloads are the day's quota. */
export const IDENTIFY_LIMIT = 5;

/** Codecs a subtitle can be read out of as text. Image tracks (PGS, VobSub) cannot be compared. */
const TEXT_CODECS = new Set(["mov_text", "subrip", "srt", "ass", "ssa", "webvtt", "vtt", "text", "tx3g"]);

export function isTextSubtitleCodec(codec: string | null | undefined): boolean {
  return !!codec && TEXT_CODECS.has(codec.toLowerCase());
}

export interface EmbeddedTrack {
  /** Jellyfin's stream index, which is what its subtitle endpoint takes. */
  index: number;
  codec: string | null;
  language: string | null;
}

export interface SeriesEpisode {
  path: string;
  season: number;
  episode: number;
  /** A subtitle file sitting next to the video on disk. */
  externalFile: string | null;
  /** Built-in subtitle tracks Jellyfin reports, text or image. */
  embedded: EmbeddedTrack[];
  /** Jellyfin reports a subtitle stream of any kind (its own listing; may know of an external one too). */
  jellyfinHasSubtitle: boolean;
  /** This episode's own ids, when they are known to belong to this show and this episode. */
  episodeImdbId?: string | null;
  episodeTmdbId?: number | null;
}

/** The console's isMissingSubtitles, plus a sidecar written since Jellyfin last looked. */
export function needsSubtitle(e: SeriesEpisode): boolean {
  return !e.externalFile && !e.jellyfinHasSubtitle && e.embedded.length === 0;
}

const ENGLISH = new Set(["en", "eng", "english"]);

function englishOrUnknown(t: EmbeddedTrack): number {
  const l = (t.language ?? "").toLowerCase();
  if (ENGLISH.has(l)) return 2;
  if (!l || l === "und") return 1;
  return 0;
}

export type Reference =
  | { kind: "external"; episode: SeriesEpisode; file: string }
  | { kind: "embedded"; episode: SeriesEpisode; track: EmbeddedTrack }
  | { kind: "none" };

/**
 * Which episode to learn from: an external file first, then a built-in text
 * track (English, or unlabelled, before another language). Among several, one
 * from the season with the most episodes to fill, since an uploader times a
 * season against one release; then the earliest.
 */
export function chooseReference(episodes: readonly SeriesEpisode[]): Reference {
  const wanted = new Map<number, number>();
  for (const e of episodes) if (needsSubtitle(e)) wanted.set(e.season, (wanted.get(e.season) ?? 0) + 1);
  const order = (a: SeriesEpisode, b: SeriesEpisode) =>
    (wanted.get(b.season) ?? 0) - (wanted.get(a.season) ?? 0) || a.season - b.season || a.episode - b.episode;

  const external = episodes.filter((e) => e.externalFile).sort(order)[0];
  if (external) return { kind: "external", episode: external, file: external.externalFile! };

  const withText = episodes
    .map((e) => ({
      e,
      track: e.embedded
        .filter((t) => isTextSubtitleCodec(t.codec) && englishOrUnknown(t) > 0)
        .sort((a, b) => englishOrUnknown(b) - englishOrUnknown(a) || a.index - b.index)[0],
    }))
    .filter((x): x is { e: SeriesEpisode; track: EmbeddedTrack } => !!x.track)
    .sort((a, b) => englishOrUnknown(b.track) - englishOrUnknown(a.track) || order(a.e, b.e))[0];
  if (withText) return { kind: "embedded", episode: withText.e, track: withText.track };

  return { kind: "none" };
}

export type PickMethod = "family" | "moviehash" | "best-rated";

export interface EpisodePick {
  candidate: SubtitleCandidate;
  method: PickMethod;
  why: string[];
}

const METHOD_LABEL: Record<PickMethod, string> = {
  family: "same family as the reference",
  moviehash: "synced to this exact file",
  "best-rated": "best-rated for this episode",
};

/**
 * Matching an episode on its own: what OpenSubtitles says was timed against
 * this very file, then the best release for the episode — not hearing-
 * impaired (someone who wants SDH picks it by hand), a trusted uploader, a
 * rating with enough votes to mean something, then downloads.
 */
export function pickWithoutReference(candidates: readonly SubtitleCandidate[]): EpisodePick | null {
  const usable = candidates.filter((c) => c.fileId > 0);
  const rank = (a: SubtitleCandidate, b: SubtitleCandidate) =>
    Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
    Number(!!b.fromTrusted) - Number(!!a.fromTrusted) ||
    ratedScore(b) - ratedScore(a) ||
    b.downloadCount - a.downloadCount;

  const synced = usable.filter((c) => c.hashMatch).sort(rank)[0];
  if (synced) return { candidate: synced, method: "moviehash", why: [] }; // the method says it

  const best = [...usable].sort(rank)[0];
  if (!best) return null;
  const why: string[] = [];
  if (best.fromTrusted) why.push("trusted uploader");
  if (ratedScore(best) > 0) why.push(`rated ${best.rating!.toFixed(1)} by ${best.votes}`);
  why.push(`${best.downloadCount.toLocaleString("en")} downloads`);
  if (best.hearingImpaired) why.push("hearing-impaired (no other)");
  return { candidate: best, method: "best-rated", why };
}

/** A rating counts once three people have voted; OpenSubtitles' 0-10 scale. */
function ratedScore(c: SubtitleCandidate): number {
  return c.rating && c.votes && c.votes >= 3 ? c.rating : 0;
}

const FAMILY_SIGNALS = new Set(["same uploader", "same release", "similar release"]);

/** The family first when there is one, then the episode on its own. */
export function pickForEpisode(
  candidates: readonly SubtitleCandidate[],
  family: SubtitleFamily | null,
  videoName: string,
): EpisodePick | null {
  if (family) {
    const fam = pickFromFamily(candidates, family, videoName);
    // Called "family" only when it is: a moviehash match alone clears the
    // family bar too, and is then the moviehash pick below, said as such.
    if (fam && fam.why.some((w) => FAMILY_SIGNALS.has(w))) return { candidate: fam.candidate, method: "family", why: fam.why };
  }
  return pickWithoutReference(candidates);
}

export function methodLabel(m: PickMethod): string {
  return METHOD_LABEL[m];
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

export interface EpisodeSearch {
  /** The show's ids; one of them is needed unless the episode's own id is known. */
  parentImdbId: string | null;
  parentTmdbId: number | null;
  season: number;
  episode: number;
  episodeImdbId: string | null;
  episodeTmdbId: number | null;
  moviehash: string | null;
}

export interface PlanDeps {
  search(input: EpisodeSearch): Promise<SubtitleCandidate[]>;
  /** Spends one of the day's downloads. */
  download(fileId: number): Promise<{ content: string; remaining: number }>;
  readExternal(file: string): Promise<string>;
  /** The built-in track's text (Jellyfin extracts it with its own ffmpeg). */
  readEmbedded(episode: SeriesEpisode, track: EmbeddedTrack): Promise<string>;
  moviehash(path: string): string | null;
  basename(path: string): string;
}

export interface EpisodePlan {
  path: string;
  season: number;
  episode: number;
  status: "planned" | "no-match" | "error";
  pick?: {
    fileId: number;
    release: string | null;
    fileName: string | null;
    uploader: string | null;
    method: PickMethod;
    methodLabel: string;
    why: string[];
  };
  note?: string;
}

export interface PlanReference {
  kind: "external" | "embedded" | "none";
  path: string | null;
  season: number | null;
  episode: number | null;
  /** The external file, or "built-in track N (mov_text, eng)". */
  source: string | null;
  family: SubtitleFamily | null;
  similarity: number | null;
  note: string;
}

export interface PlanSummary {
  episodes: number;
  needSubtitles: number;
  builtIn: number;
  external: number;
  /** Files with no season/episode in their name; not planned for. */
  unparsed: number;
}

export interface BuiltPlan {
  reference: PlanReference;
  summary: PlanSummary;
  headline: string;
  episodes: EpisodePlan[];
  downloadsUsed: number;
  downloadsLeft: number | null;
}

export function summarise(episodes: readonly SeriesEpisode[], unparsed: number): PlanSummary {
  return {
    episodes: episodes.length + unparsed,
    needSubtitles: episodes.filter(needsSubtitle).length,
    builtIn: episodes.filter((e) => !e.externalFile && (e.embedded.length > 0 || e.jellyfinHasSubtitle)).length,
    external: episodes.filter((e) => e.externalFile).length,
    unparsed,
  };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "3 episodes need subtitles; 141 already have built-in ones." */
export function headline(s: PlanSummary): string {
  const parts = [`${plural(s.needSubtitles, "episode")} ${s.needSubtitles === 1 ? "needs" : "need"} subtitles`];
  if (s.builtIn) parts.push(`${s.builtIn} already ${s.builtIn === 1 ? "has a built-in one" : "have built-in ones"}`);
  if (s.external) parts.push(`${s.external} ${s.external === 1 ? "has a subtitle file" : "have subtitle files"}`);
  let text = parts.join("; ") + ".";
  if (s.unparsed) text += ` ${plural(s.unparsed, "file")} without an episode number in the name ${s.unparsed === 1 ? "was" : "were"} left out.`;
  return text;
}

function familyOf(c: SubtitleCandidate): SubtitleFamily {
  return { uploader: c.uploader, release: c.release, fileName: c.fileName, hearingImpaired: c.hearingImpaired, fps: c.fps };
}

function searchFor(e: SeriesEpisode, show: { imdbId: string | null; tmdbId: number | null }, hash: string | null): EpisodeSearch {
  return {
    parentImdbId: show.imdbId,
    parentTmdbId: show.tmdbId,
    season: e.season,
    episode: e.episode,
    episodeImdbId: e.episodeImdbId ?? null,
    episodeTmdbId: e.episodeTmdbId ?? null,
    moviehash: hash,
  };
}

/**
 * Which search result the reference text is. Candidates synced to the
 * reference's video go first (most likely to be it), then the most downloaded;
 * stops at the first unmistakable match. With no match by words, the one
 * synced to that video stands in, said as much.
 */
export async function identifyFamily(
  referenceText: string,
  candidates: readonly SubtitleCandidate[],
  deps: Pick<PlanDeps, "download">,
  budget: { used: number; left: number | null },
): Promise<{ family: SubtitleFamily; similarity: number | null; note: string } | null> {
  const ordered = [...candidates].sort(
    (a, b) => Number(b.hashMatch) - Number(a.hashMatch) || b.downloadCount - a.downloadCount,
  );
  let best: { c: SubtitleCandidate; sim: number } | null = null;
  for (const c of ordered.slice(0, IDENTIFY_LIMIT)) {
    if (budget.left !== null && budget.left <= 0) break;
    try {
      const d = await deps.download(c.fileId);
      budget.used += 1;
      budget.left = d.remaining;
      const sim = subtitleTextSimilarity(referenceText, d.content);
      if (!best || sim > best.sim) best = { c, sim };
      if (sim >= 0.9) break; // unmistakable; stop spending
    } catch {
      /* one failed download is not a reason to give up on the rest */
    }
  }
  if (best && best.sim >= MIN_TEXT_SIMILARITY) {
    return {
      family: familyOf(best.c),
      similarity: best.sim,
      note: `It matches ${best.c.uploader ?? "an upload"}'s "${best.c.release ?? best.c.fileName}" (${Math.round(best.sim * 100)}% of lines).`,
    };
  }
  const synced = ordered.find((c) => c.hashMatch);
  if (synced) {
    return {
      family: familyOf(synced),
      similarity: best?.sim ?? null,
      note: "Couldn't confirm which upload it is by its words; following the one synced to that episode's video.",
    };
  }
  return null;
}

function describeTrack(t: EmbeddedTrack): string {
  return `built-in track ${t.index} (${[t.codec, t.language].filter(Boolean).join(", ")})`;
}

/**
 * The whole plan. `episodes` are the show's numbered files; `unparsed` is how
 * many had no number, for the header. Downloads are spent only identifying
 * the reference (at most IDENTIFY_LIMIT); every pick is a search result.
 */
export async function buildSeriesPlan(
  input: {
    episodes: readonly SeriesEpisode[];
    unparsed: number;
    show: { imdbId: string | null; tmdbId: number | null };
  },
  deps: PlanDeps,
): Promise<BuiltPlan> {
  const { episodes, show } = input;
  const summary = summarise(episodes, input.unparsed);
  const targets = episodes.filter(needsSubtitle).sort((a, b) => a.season - b.season || a.episode - b.episode);
  const budget = { used: 0, left: null as number | null };
  const out: BuiltPlan = {
    reference: { kind: "none", path: null, season: null, episode: null, source: null, family: null, similarity: null, note: "" },
    summary,
    headline: headline(summary),
    episodes: [],
    downloadsUsed: 0,
    downloadsLeft: null,
  };
  if (targets.length === 0) {
    out.reference.note = "Nothing to do.";
    return out;
  }
  const canSearch = (e: SeriesEpisode) => !!(show.imdbId || show.tmdbId || e.episodeImdbId || e.episodeTmdbId);

  // Learn from the reference, if there is one worth learning from.
  const ref = chooseReference(episodes);
  let family: SubtitleFamily | null = null;
  if (ref.kind === "none") {
    out.reference.note =
      "No episode has subtitles to learn from, so each one is matched on its own: the subtitle synced to that exact file first, else the best-rated one for the episode.";
  } else {
    const e = ref.episode;
    const source = ref.kind === "external" ? deps.basename(ref.file) : describeTrack(ref.track);
    out.reference = { ...out.reference, kind: ref.kind, path: e.path, season: e.season, episode: e.episode, source };
    let text: string | null = null;
    try {
      text = ref.kind === "external" ? await deps.readExternal(ref.file) : await deps.readEmbedded(e, ref.track);
    } catch (error) {
      out.reference.note = `Couldn't read ${source}: ${error instanceof Error ? error.message : String(error)}. Matching each episode on its own instead.`;
    }
    if (text !== null && !canSearch(e)) {
      out.reference.note = "The show isn't linked to TMDB, so the reference can't be looked up. Matching each episode on its own instead.";
    } else if (text !== null) {
      try {
        const candidates = await deps.search(searchFor(e, show, deps.moviehash(e.path)));
        const identified = await identifyFamily(text, candidates, deps, budget);
        if (identified) {
          family = identified.family;
          out.reference.family = identified.family;
          out.reference.similarity = identified.similarity;
          out.reference.note = identified.note;
        } else {
          out.reference.note = `None of its ${candidates.length} OpenSubtitles results is this subtitle, so each episode is matched on its own instead.`;
        }
      } catch (error) {
        out.reference.note = `Couldn't look the reference up (${error instanceof Error ? error.message : String(error)}). Matching each episode on its own instead.`;
      }
    }
  }

  for (const e of targets) {
    const base = { path: e.path, season: e.season, episode: e.episode };
    if (!canSearch(e)) {
      out.episodes.push({ ...base, status: "no-match", note: "The show isn't linked to TMDB, so there is nothing to search by." });
      continue;
    }
    try {
      const candidates = await deps.search(searchFor(e, show, deps.moviehash(e.path)));
      const pick = pickForEpisode(candidates, family, deps.basename(e.path));
      out.episodes.push(
        pick
          ? {
              ...base,
              status: "planned",
              pick: {
                fileId: pick.candidate.fileId,
                release: pick.candidate.release,
                fileName: pick.candidate.fileName,
                uploader: pick.candidate.uploader,
                method: pick.method,
                methodLabel: methodLabel(pick.method),
                why: pick.why,
              },
            }
          : { ...base, status: "no-match", note: candidates.length ? `${candidates.length} results, none usable.` : "OpenSubtitles has no English subtitle for this episode." },
      );
    } catch (error) {
      out.episodes.push({ ...base, status: "error", note: error instanceof Error ? error.message : String(error) });
    }
  }

  out.downloadsUsed = budget.used;
  out.downloadsLeft = budget.left;
  return out;
}
