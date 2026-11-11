/**
 * Guessing which library items are special features, and what they are about.
 *
 * Pure functions with no database or Jellyfin access, so the scoring can be
 * tested directly — the whole value of a guesser is knowing what it does on
 * the awkward cases, and that is impossible to check if it only runs against
 * a live library.
 *
 * Everything here PROPOSES. Nothing is ever applied without a curator saying
 * yes in the console: the cost of a wrong guess is a film vanishing from
 * Browse into some other film's extras, which is much worse than the cost of
 * confirming a right one.
 */

import { findEpisodeMarker } from "./episode-markers.ts";

export interface GuessCandidate {
  itemId: string;
  title: string;
  year: number | null;
  overview: string | null;
  /** The file's path, for spotting an extra that sits among a show's episodes. */
  path?: string | null;
}

export interface GuessTargetOption {
  kind: "film" | "franchise" | "director" | "actor";
  targetId: string;
  targetLabel: string;
  /** Why this target was proposed, shown verbatim in the console. */
  reason: string;
}

export interface Guess {
  itemId: string;
  title: string;
  /** 0-100. Only a sort order and a hint — never a threshold for acting. */
  confidence: number;
  /** Why we think it is a special feature at all. */
  reasons: string[];
  targets: GuessTargetOption[];
  /** A tidier name than the file's, when the guess can offer one ("I'm Cordelia" for "Angel.1xEX.I'm_Cordelia.dvdrip.x264"). */
  suggestedName?: string | null;
}

/**
 * Phrases that make something a special feature rather than a film.
 *
 * Ordered strongest first. "Making of" is close to conclusive; "documentary"
 * on its own is not — plenty of standalone documentaries are exactly what
 * somebody sat down to watch, and demoting those out of Browse would be the
 * worst thing this feature could do. So the weak signals cannot reach a high
 * score on their own.
 */
const TITLE_SIGNALS: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /\bmaking of\b|\bthe making\b/i, weight: 55, label: "title says “making of”" },
  { pattern: /\bbehind the scenes\b|\bb-?roll\b/i, weight: 55, label: "title says “behind the scenes”" },
  { pattern: /\bfeaturette\b|\bextras?\b|\bbonus\b/i, weight: 50, label: "title says featurette/bonus" },
  { pattern: /\bdeleted scenes?\b|\bouttakes?\b|\bbloopers?\b/i, weight: 60, label: "deleted scenes or outtakes" },
  { pattern: /\bcommentary\b/i, weight: 45, label: "title mentions commentary" },
  { pattern: /\binterview\b|\bin conversation\b|\bmasterclass\b/i, weight: 35, label: "interview or conversation" },
  { pattern: /\bretrospective\b|\bprofile\b|\ba life in\b/i, weight: 30, label: "retrospective or profile" },
  { pattern: /\bdocumentary\b/i, weight: 15, label: "described as a documentary" },
];

/** ": The Making of X" and friends — the part after the colon names the subject. */
const ABOUT_PATTERNS: RegExp[] = [
  /\bmaking of\s+(?:the\s+)?["“']?([^"”':]+)["”']?/i,
  /\bbehind the scenes(?:\s+of)?\s+["“']?([^"”':]+)["”']?/i,
  /\bthe world of\s+["“']?([^"”':]+)["”']?/i,
  /\bthe story of\s+["“']?([^"”':]+)["”']?/i,
];

export function scoreCandidate(candidate: GuessCandidate): { confidence: number; reasons: string[] } {
  const haystackTitle = candidate.title ?? "";
  const overview = candidate.overview ?? "";
  let score = 0;
  const reasons: string[] = [];

  for (const signal of TITLE_SIGNALS) {
    if (signal.pattern.test(haystackTitle)) {
      score += signal.weight;
      reasons.push(signal.label);
    } else if (signal.pattern.test(overview)) {
      // The same phrase in a synopsis is much weaker evidence than in a title:
      // a film's own synopsis can mention a documentary without being one.
      score += Math.round(signal.weight / 3);
      reasons.push(`${signal.label} (in the synopsis)`);
    }
  }

  return { confidence: Math.max(0, Math.min(100, score)), reasons };
}

/** The subject named in a title like "The Making of Alien". */
export function extractSubject(title: string): string | null {
  for (const pattern of ABOUT_PATTERNS) {
    const match = pattern.exec(title);
    const subject = match?.[1]?.trim();
    if (subject && subject.length > 1) return subject;
  }
  return null;
}

/** Comparable form: case, punctuation and a leading article all removed. */
export function normaliseTitle(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      // Collapse and trim BEFORE stripping the article, not after: punctuation
      // above turns into spaces, so " A  Film" still has a leading run of them
      // and an anchored ^(the|a|an) would never match.
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(the|a|an)\s+/, "")
  );
}

export interface KnownThings {
  films: { id: string; title: string }[];
  /**
   * Library groups: shows, and films kept in parts. `kind` is "series" for a
   * show linked as one, "movie" for a film in parts or a franchise, null when
   * nobody has said. `paths` are the members' files, which is how an extra
   * left in a show's folder is recognised as that show's.
   */
  groups: { id: string; name: string; kind?: "series" | "movie" | null; paths?: string[] }[];
  people: { id: string; name: string; kind: "director" | "actor" }[];
}

/**
 * What a candidate might be about, given everything the library knows.
 *
 * Matching is on the whole normalised title, not a substring: "Alien" as a
 * substring appears in half the library's synopses and would propose nonsense.
 * A person's name is the exception — those are distinctive enough to look for
 * anywhere in the title, and "Hitchcock/Truffaut" is exactly the case that
 * needs it.
 */
export function proposeTargets(candidate: GuessCandidate, known: KnownThings): GuessTargetOption[] {
  const out: GuessTargetOption[] = [];
  const subject = extractSubject(candidate.title);
  const normalisedSubject = subject ? normaliseTitle(subject) : null;
  const title = candidate.title ?? "";

  if (normalisedSubject) {
    for (const film of known.films) {
      if (film.id === candidate.itemId) continue;
      if (normaliseTitle(film.title) === normalisedSubject) {
        out.push({
          kind: "film",
          targetId: film.id,
          targetLabel: film.title,
          reason: `title names “${subject}”`,
        });
      }
    }
    for (const group of known.groups) {
      if (normaliseTitle(group.name) === normalisedSubject) {
        out.push({
          kind: "franchise",
          targetId: group.id,
          targetLabel: group.name,
          reason: `title names the “${group.name}” group`,
        });
      }
    }
  }

  for (const person of known.people) {
    const name = person.name?.trim();
    // Single-word names match far too much ("Cher", "Madonna", and every
    // surname that is also a word). Require a full name before proposing.
    if (!name || name.split(/\s+/).length < 2) continue;
    if (containsName(title, name) || containsName(candidate.overview ?? "", name)) {
      out.push({
        kind: person.kind,
        targetId: person.id,
        targetLabel: name,
        reason: containsName(title, name)
          ? `title names ${name}`
          : `synopsis names ${name}`,
      });
    }
  }

  const show = showFolderMatch(candidate, known);
  if (show && !out.some((t) => t.kind === "franchise" && t.targetId === show.id)) {
    out.push({
      kind: "franchise",
      targetId: show.id,
      targetLabel: show.name,
      reason: `in ${show.name}'s folder, among its episodes`,
    });
  }

  // Most specific first, matching how the film page orders them.
  const rank = { film: 0, franchise: 1, director: 2, actor: 3 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 8);
}

function containsName(haystack: string, name: string): boolean {
  const normalisedHaystack = ` ${normaliseTitle(haystack)} `;
  const normalisedName = normaliseTitle(name);
  return normalisedName.length > 0 && normalisedHaystack.includes(` ${normalisedName} `);
}

/**
 * The full guess for one candidate, or null if there is nothing to say.
 *
 * A candidate with a strong title signal is worth proposing even with no
 * target: "Deleted Scenes" clearly does not belong in Browse, and a curator
 * can map it by hand. The reverse — a target match with no signal — is not
 * worth proposing, because "a film whose title matches another film" is a
 * sequel far more often than it is a documentary.
 */
export function guess(candidate: GuessCandidate, known: KnownThings): Guess | null {
  const scored = scoreCandidate(candidate);
  const reasons = [...scored.reasons];
  let confidence = scored.confidence;

  // A file with no episode number, left among a show's episodes but not one
  // of them, is that show's DVD extra: the featurette, the bloopers reel.
  const show = showFolderMatch(candidate, known);
  if (show) {
    confidence += 50;
    reasons.push(`in ${show.name}'s folder but not one of its episodes`);
  }
  if (confidence < 25) return null;

  const targets = proposeTargets(candidate, known);
  // A matched target is real corroboration, so it lifts the score.
  const boosted = Math.min(100, confidence + (targets.length > 0 ? 20 : 0));

  return {
    itemId: candidate.itemId,
    title: candidate.title,
    confidence: boosted,
    reasons,
    targets,
    suggestedName: show && candidate.path ? extraName(candidate.path, show.name) : null,
  };
}

/* ------------------------------------------------------------------ *
 * Extras left in a show's folder
 * ------------------------------------------------------------------ */

const SEASON_FOLDER = /^(season|series|saison|staffel)[\s._-]*\d+$|^s\d{1,2}$|^specials?$/i;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function stemOf(path: string): string {
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The show whose episodes share this file's folder (or the folder above, when
 * the file sits in a "Season 3" folder of its own), or null.
 *
 * Careful in three ways, since a wrong answer moves a film out of Browse:
 *  - a file with an episode marker of its own is an episode waiting to be
 *    grouped, never an extra;
 *  - a group nobody has linked as a show can still match (most shows here
 *    were grouped before kinds existed), but a film kept in parts or a
 *    franchise ("movie") cannot: its folder is often shared with other films;
 *  - a folder directly under the library root ("/media/TV") is shared by
 *    everything in it and proves nothing;
 *  - the show's files in that folder must be numbered by their filenames
 *    ("1x05", "s3e12"). Looney Tunes (numbered by hand) and mini-series kept
 *    in a director's folder failed the dry run against the live library
 *    without this: their folders hold duplicates and other films.
 */
export function showFolderMatch(
  candidate: GuessCandidate,
  known: KnownThings,
): { id: string; name: string } | null {
  const path = candidate.path;
  if (!path) return null;
  const marker = findEpisodeMarker(stemOf(path));
  if (marker.episode !== null) return null;

  const dir = dirOf(path);
  const dirs = [dir];
  if (SEASON_FOLDER.test(baseOf(dir))) dirs.push(dirOf(dir));

  for (const group of known.groups) {
    if (group.kind === "movie" || !group.paths?.length) continue;
    if (group.paths.includes(path)) return null; // it IS an episode
    // Per folder: how many of the show's files are there, and how many of
    // those are numbered by their own filenames.
    const folders = new Map<string, { members: number; numbered: number }>();
    const count = (d: string, numbered: boolean) => {
      const c = folders.get(d) ?? { members: 0, numbered: 0 };
      c.members++;
      if (numbered) c.numbered++;
      folders.set(d, c);
    };
    for (const p of group.paths) {
      const numbered = findEpisodeMarker(stemOf(p)).episode !== null;
      const d = dirOf(p);
      count(d, numbered);
      if (SEASON_FOLDER.test(baseOf(d))) count(dirOf(d), numbered);
    }
    for (const d of dirs) {
      // "/media/TV" has two segments: too shallow to belong to one show.
      if (d.split("/").filter(Boolean).length < 3) continue;
      const c = folders.get(d);
      // The folder must be the show's numbered episodes. A group whose files
      // carry no episode numbers (shorts numbered by hand, a mini-series in a
      // director's folder) shares its folder with things that are not extras.
      if (c && c.numbered >= 2 && c.numbered >= 0.8 * c.members) return { id: group.id, name: group.name };
    }
  }
  return null;
}

const NAME_NOISE =
  /\b(1080p|2160p|720p|480p|4k|uhd|web[- ]?dl|webrip|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|dts|remux|proper|repack)\b/i;

/**
 * A readable name for an extra from its filename: release noise cut, dots and
 * underscores made spaces, the show's own name and an "1xEX"-style marker
 * taken off the front. "Angel.1xEX.I'm_Cordelia.dvdrip.x264" → "I'm Cordelia".
 * Falls back to the cleaned stem rather than returning nothing.
 */
export function extraName(path: string, showName: string): string {
  const stem = stemOf(path);
  const noise = NAME_NOISE.exec(stem);
  const cut = (noise ? stem.slice(0, noise.index) : stem)
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s\-–—:]+$/, "");

  const show = showName.trim().replace(/[._]+/g, " ");
  let name = cut;
  if (show && name.toLowerCase().startsWith(show.toLowerCase() + " ")) {
    name = name.slice(show.length).trim();
  }
  name = name
    .replace(/^[\s\-–—:]+/, "")
    .replace(/^(s?\d{1,2}\s?x?\s?)?(ex|extras?|bonus)\b[\s\-–—:]*/i, "")
    .replace(/^[\s\-–—:]+/, "")
    .trim();
  return name.length >= 3 ? name : cut;
}
