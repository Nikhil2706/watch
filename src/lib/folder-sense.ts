/**
 * What the folders a file sits in say about it.
 *
 * The library is filed by hand: "American/Steven Spielberg", "Harun Farocki",
 * "Horror/Unclassified". Jellyfin reads none of that. It searches on the
 * filename alone, so "Amblin.1968.VHSRIP.XViD-CG.avi" inside the Spielberg
 * folder is a bare word to it, and thirty-odd Farocki shorts with names like
 * "Harun Farocki - (1983) An Image" find nothing at all.
 *
 * To a person the folder settles it: a file called Amblin in a folder called
 * Steven Spielberg is his short film. These are the rules for reading a path
 * that way — which folders name a person, a genre or a country, what title a
 * filename is claiming once the director's own name is taken out of it, and
 * how sure a match against that person's films is.
 *
 * Pure and free of server-only, so every rule is tested against the real
 * filenames it was written for. Who the person is and what they made comes
 * from the caller (folder-match.ts).
 */

import { editDistance, normaliseTitle, titlesAgree } from "./match-audit.ts";

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

/** Letters NFKD leaves alone: "Żuławski" must still meet "Zulawski". */
const UNDECOMPOSED: Record<string, string> = {
  ł: "l", Ł: "L", ø: "o", Ø: "O", đ: "d", Đ: "D", ß: "ss", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ı: "i",
};

function foldLetters(text: string): string {
  return text.replace(/[łŁøØđĐßæÆœŒı]/g, (ch) => UNDECOMPOSED[ch] ?? ch);
}

/** A person's or folder's name as bare lowercase words. */
export function nameWords(name: string): string[] {
  return foldLetters(name)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Could this folder be named after this person?
 *
 * The folders are typed by hand and about one in six is misspelt: "Luca
 * Guadanino", "William Freidkin", "Kathour Ben Hania", "Roberto Rosselini".
 * Others are a surname alone ("Bresson", "Safdie") or two people ("Michael
 * Angelo Covino and Kyle Marvin"). So: the same words, or the folder's words
 * all within the person's, or a few letters apart, or the same surname behind
 * the same initial.
 *
 * Loose on purpose, and safe only because of how it is used — the caller asks
 * it about people who directed films already in that folder, or about TMDB's
 * own answers to a search for the folder's name. It is never run against
 * everybody.
 */
export function folderNamesPerson(folder: string, person: string): boolean {
  const who = nameWords(person);
  if (who.length === 0) return false;
  const parts = folder.split(/\s+(?:and|&|et|y)\s+|\s*[,&]\s*/i);
  return parts.some((part) => {
    const typed = nameWords(part);
    if (typed.length === 0) return false;
    const a = typed.join(" ");
    const b = who.join(" ");
    if (a === b) return true;
    // "Bresson", "Safdie", "Refn": every word of the folder is one of theirs.
    // One word has to be the surname, or "Park" would name every Park.
    if (typed.every((w) => who.includes(w))) {
      return typed.length > 1 || (typed[0]!.length >= 4 && typed[0] === who[who.length - 1]);
    }
    if (typed.length < 2) return false;
    if (editDistance(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 5))) return true;
    // "Kathour Ben Hania" for Kaouther Ben Hania: everything after the first
    // name is right and the first name is a bad spelling of theirs. The rest
    // has to match word for word, or Paul Thomas Anderson's folder would
    // name Paul W.S. Anderson.
    return (
      typed.length === who.length &&
      typed.slice(1).join(" ") === who.slice(1).join(" ") &&
      typed[0]![0] === who[0]![0] &&
      editDistance(typed[0]!, who[0]!) <= 4
    );
  });
}

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

/** TMDB's film genre ids, by the words a folder might use for them. */
const GENRES: Record<string, { id: number; label: string }> = {
  horror: { id: 27, label: "Horror" },
  comedy: { id: 35, label: "Comedy" },
  comedies: { id: 35, label: "Comedy" },
  documentary: { id: 99, label: "Documentary" },
  documentaries: { id: 99, label: "Documentary" },
  docs: { id: 99, label: "Documentary" },
  animation: { id: 16, label: "Animation" },
  animated: { id: 16, label: "Animation" },
  western: { id: 37, label: "Western" },
  westerns: { id: 37, label: "Western" },
  thriller: { id: 53, label: "Thriller" },
  thrillers: { id: 53, label: "Thriller" },
  "sci fi": { id: 878, label: "Science Fiction" },
  scifi: { id: 878, label: "Science Fiction" },
  "science fiction": { id: 878, label: "Science Fiction" },
  romance: { id: 10749, label: "Romance" },
  musical: { id: 10402, label: "Music" },
  musicals: { id: 10402, label: "Music" },
  war: { id: 10752, label: "War" },
  crime: { id: 80, label: "Crime" },
  action: { id: 28, label: "Action" },
  fantasy: { id: 14, label: "Fantasy" },
  mystery: { id: 9648, label: "Mystery" },
};

/**
 * A country folder, as the languages its films are most likely in. A search
 * result carries its original language and not its country, so the language
 * is what a candidate can be held against.
 */
const COUNTRIES: Record<string, string[]> = {
  american: ["en"], british: ["en"], australian: ["en"], canadian: ["en", "fr"], irish: ["en", "ga"],
  french: ["fr"], italian: ["it"], spanish: ["es"], german: ["de"], japanese: ["ja"],
  korean: ["ko"], chinese: ["zh", "cn"], russian: ["ru"], soviet: ["ru"], iranian: ["fa"],
  indian: ["hi", "ta", "te", "ml", "bn", "kn", "mr", "pa", "ur", "en"],
  mexican: ["es"], brazilian: ["pt"], portuguese: ["pt"], polish: ["pl"], swedish: ["sv"],
  danish: ["da"], thai: ["th"], turkish: ["tr"], greek: ["el"], hungarian: ["hu"], czech: ["cs"],
};

/** `folder` is the folder's own name, `path` where it is ("/media/American/Steven Spielberg"). */
export type FolderHint =
  | { kind: "genre"; folder: string; path: string; genreId: number; label: string }
  | { kind: "country"; folder: string; path: string; languages: string[] }
  /** Neither of the above, so possibly somebody's name. The caller finds out. */
  | { kind: "name"; folder: string; path: string };

/** A folder that holds one film: it has a year or a release tag in its name. */
function isReleaseFolder(name: string): boolean {
  return /(?<!\d)(18[89]\d|19\d\d|20\d\d)(?!\d)/.test(name) || RELEASE_JUNK.test(name) || /S\d{1,2}(E\d|\b)/i.test(name);
}

/**
 * The folders above a file, nearest first, each read for what it says.
 *
 * `path` and `root` as Jellyfin sees them ("/media/American/Steven
 * Spielberg/Amblin.1968.avi", "/media"). A folder that holds a single film
 * ("Always (1989) [1080p]") says nothing about the others and is left out.
 */
export function folderHints(path: string, root: string): FolderHint[] {
  const base = root.replace(/\/+$/, "");
  if (!path.startsWith(base + "/")) return [];
  const folders = path.slice(base.length + 1).split("/").slice(0, -1);
  const hints: FolderHint[] = [];
  for (let depth = folders.length; depth > 0; depth--) {
    const folder = folders[depth - 1]!;
    if (isReleaseFolder(folder)) continue;
    const key = nameWords(folder).join(" ");
    if (!key) continue;
    const at = `${base}/${folders.slice(0, depth).join("/")}`;
    const genre = GENRES[key];
    const languages = COUNTRIES[key];
    if (genre) hints.push({ kind: "genre", folder, path: at, genreId: genre.id, label: genre.label });
    else if (languages) hints.push({ kind: "country", folder, path: at, languages });
    else hints.push({ kind: "name", folder, path: at });
  }
  return hints;
}

/* ------------------------------------------------------------------ *
 * The title a filename is claiming
 * ------------------------------------------------------------------ */

const RELEASE_JUNK =
  /\b(1080p|2160p|1440p|720p|480p|4k|uhd|web[- ]?dl|webrip|bluray|blu[- ]?ray|bluray ?rip|brrip|bdrip|dvdrip|dvd|vhsrip|vhs|hdrip|hdtv|xvid|divx|x264|x265|h ?264|h ?265|hevc|avc|av1|aac\d*|ac3|dts|remux|proper|repack|amzn|multi|yts|rarbg|cd ?\d|sd|eng(?:lish)? subs?|with english subtitles)\b/i;

const YEAR = /(?<![\dp])(18[89]\d|19\d\d|20\d\d)(?![\dp])/;

export interface ClaimedTitle {
  /** Every reading of the name worth trying, the fullest first. Never empty strings. */
  titles: string[];
  year: number | null;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Take the names of the folder's people out of a title.
 *
 * "Harun Farocki - Between Two Wars", "Ausweg Farocki", "Bedtime Stories Cat
 * HFarocki", "Ein Bild (Harun Farocki, 1983)". Only at the edges and only as
 * whole words: "Hands of Bresson" and "L'India vista da Rossellini" are
 * titles with a name in them, and stay whole.
 */
function withoutNames(title: string, names: readonly string[]): string {
  let out = title;
  for (const name of names) {
    const words = nameWords(name);
    if (words.length === 0) continue;
    const surname = words[words.length - 1]!;
    const full = words.join("[\\s.]+");
    // The whole name, or an initial run into the surname ("HFarocki").
    const who = `(?:${full}|[a-z]\\.?\\s?${surname}|${surname})`;
    out = out
      .replace(new RegExp(`^\\s*${who}\\s*[-:,]+\\s*`, "i"), "")
      .replace(new RegExp(`\\s*[-:,(]+\\s*${who}\\s*\\)?\\s*$`, "i"), "")
      .replace(new RegExp(`\\s+(?:${words.length > 1 ? `${full}|` : ""}[a-z]${surname})\\s*$`, "i"), "")
      .replace(new RegExp(`\\s+(?:di|by|de|von)\\s+(?:${full}|${surname})\\b.*$`, "i"), "");
  }
  return out.trim();
}

/**
 * What film a file says it is, read every reasonable way.
 *
 * `names` are the people the folders point to (and the folder names
 * themselves), so their names can be taken off the ends. Returns several
 * readings rather than one because a filename does not say which part of it
 * is the title: "Aufschub AKA Respite", "Die Schulung - Indoctrination",
 * "Andrei Ujica 1992 Videogramme einer Revolution". Matching is against one
 * person's films, so an extra reading costs nothing and a missing one loses
 * the match.
 */
export function claimedTitle(path: string, names: readonly string[] = []): ClaimedTitle {
  const segments = path.split("/");
  const file = decode(segments[segments.length - 1] ?? "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const parent = decode(segments[segments.length - 2] ?? "");
  // A folder holding the one film is as good a witness as the file, and
  // often a better one ("The Duchess of Langlois/Ne touchez pas la hache").
  const sources = isReleaseFolder(parent) || names.every((n) => n !== parent) ? [file, parent] : [file];

  const titles: string[] = [];
  let year: number | null = null;
  const add = (text: string) => {
    const tidy = text.replace(/^[\s\-:,.]+|[\s\-:,.]+$/g, "").replace(/\s+/g, " ");
    if (tidy.length >= 2 && !/^\d+$/.test(tidy) && !titles.includes(tidy)) titles.push(tidy);
  };

  for (const source of sources) {
    let text = source
      .replace(/[._+]+/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      // "BedtimeStories", "Parallel2": words run together.
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")
      .replace(/^\s*\d{1,2}\s+(?=[A-Za-z])/, (m) => (YEAR.test(m) ? m : ""));
    const found = YEAR.exec(text);
    if (found && year === null) year = Number(found[1]);
    const junk = RELEASE_JUNK.exec(text);
    if (junk && junk.index > 0) text = text.slice(0, junk.index);
    // The year goes, wherever it sits; so do brackets left empty by it.
    text = text.replace(new RegExp(YEAR.source, "g"), " ").replace(/\(\s*[,;]?\s*\)/g, " ");

    const whole = withoutNames(text.replace(/\s+/g, " ").trim(), names);
    add(whole.replace(/[()]/g, " "));
    // A name in brackets after the title: "Ein Bild (Harun Farocki, )".
    add(withoutNames(whole.replace(/\([^)]*\)/g, " "), names));
    // "Ausweg Farocki": a surname left on the end. Kept as a second reading,
    // and not when a word like "of" leads into it, which makes it the title's.
    for (const name of names) {
      const surname = nameWords(name).pop();
      const tail = surname ? new RegExp(`^(.*\\S)\\s+${surname}$`, "i").exec(whole.replace(/[()]/g, " ").trim()) : null;
      if (tail && !/\b(of|on|da|de|di|du|von|by|par|sur|with|and|about)$/i.test(tail[1]!)) add(tail[1]!);
    }
    for (const side of whole.split(/\s+aka\s+/i)) add(withoutNames(side.replace(/[()]/g, " "), names));
    for (const piece of whole.split(/\s+-\s+/)) add(withoutNames(piece.replace(/[()]/g, " "), names));
  }
  return { titles, year };
}

/* ------------------------------------------------------------------ *
 * Matching against one person's films
 * ------------------------------------------------------------------ */

export interface KnownFilm {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  /** Whether the folder's person directed it, rather than appearing in it or working on it. */
  directed: boolean;
}

export type Certainty = "certain" | "likely";

export interface FolderMatch {
  film: KnownFilm;
  certainty: Certainty;
  why: string;
}

const squash = (s: string) => s.replace(/ /g, "");

/** 3 the same title, 2 the title in full inside a longer name, 1 near enough to ask about, 0 nothing. */
function closeness(claim: ClaimedTitle, film: KnownFilm): number {
  let best = 0;
  for (const known of [film.title, film.originalTitle ?? ""]) {
    const k = normaliseTitle(foldLetters(known));
    if (!k) continue;
    for (const title of claim.titles) {
      const t = normaliseTitle(foldLetters(title));
      if (!t) continue;
      if (t === k || (squash(t).length >= 3 && squash(t) === squash(k))) return 3;
      // The film's whole title somewhere in a longer filename, when the title
      // is long enough that this is no accident.
      if (k.split(" ").length >= 3 && k.length >= 12 && ` ${t} `.includes(` ${k} `)) best = Math.max(best, 2);
      else if (titlesAgree(t, k)) best = Math.max(best, 1);
    }
  }
  return best;
}

function yearFits(claim: ClaimedTitle, film: KnownFilm): "same" | "unknown" | "differs" {
  if (claim.year === null || film.year === null) return "unknown";
  return Math.abs(claim.year - film.year) <= 1 ? "same" : "differs";
}

/**
 * Which of one person's films a file is, and how sure that is.
 *
 * Certain means it can be applied without asking: the title is theirs
 * exactly, they directed it, nothing else of theirs has that title, and the
 * year in the filename (if there is one) does not disagree. Everything
 * weaker is a suggestion a person confirms. Null when nothing of theirs
 * comes close, which is the common and correct answer for a folder that
 * holds other things too.
 */
export function matchAmongFilms(
  claim: ClaimedTitle,
  films: readonly KnownFilm[],
  person: string,
): FolderMatch | null {
  const scored = films
    .map((film) => ({ film, close: closeness(claim, film), year: yearFits(claim, film) }))
    .filter((s) => s.close > 0)
    .sort(
      (a, b) =>
        b.close - a.close ||
        Number(b.year === "same") - Number(a.year === "same") ||
        Number(b.film.directed) - Number(a.film.directed),
    );
  const top = scored[0];
  if (!top) return null;

  const rivals = scored.filter((s) => s.close === top.close && s.film.tmdbId !== top.film.tmdbId);
  // Two films of theirs with the one title are told apart by the year alone.
  const alone = rivals.length === 0 || (top.year === "same" && rivals.every((r) => r.year !== "same"));
  const role = top.film.directed ? `a film by ${person}` : `${person} is credited on it`;
  const when = top.film.year ? ` (${top.film.year})` : "";

  if (top.close === 3 && alone && top.film.directed && top.year !== "differs") {
    return { film: top.film, certainty: "certain", why: `Same title as ${role}${when}` };
  }
  if (top.close === 2 && alone && top.film.directed && top.year === "same") {
    return { film: top.film, certainty: "certain", why: `The title and year of ${role}${when}` };
  }
  const doubt =
    top.year === "differs"
      ? `, but the file says ${claim.year}`
      : !alone
        ? `, and ${rivals.length} other${rivals.length === 1 ? "" : "s"} of theirs could be it`
        : "";
  return {
    film: top.film,
    certainty: "likely",
    why: `${top.close === 3 ? "Same title as" : "Close to"} ${role}${when}${doubt}`,
  };
}

/* ------------------------------------------------------------------ *
 * Matching against a search, with a genre or country folder to go on
 * ------------------------------------------------------------------ */

export interface SearchedFilm {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  year: number | null;
  genreIds: readonly number[];
  language: string | null;
  posterPath?: string | null;
}

/**
 * The best of a title search, judged with what the folders say.
 *
 * With no person to narrow it, a title alone is never certain: there are a
 * dozen films called "Creep". It takes the exact title, the year from the
 * filename and a folder that agrees ("Horror" and a horror film) to apply one
 * unasked. A folder that disagrees does not rule a film out, since people
 * file loosely; it only means asking.
 */
export function matchAmongSearch(
  claim: ClaimedTitle,
  results: readonly SearchedFilm[],
  hints: readonly FolderHint[],
): { film: SearchedFilm; certainty: Certainty; why: string } | null {
  const genres = hints.filter((h) => h.kind === "genre");
  const countries = hints.filter((h) => h.kind === "country");
  const agrees = (film: SearchedFilm): string | null => {
    const genre = genres.find((g) => film.genreIds.includes(g.genreId));
    if (genre) return `a ${genre.label.toLowerCase()} film, as the ${genre.folder} folder says`;
    const country = countries.find((c) => film.language !== null && c.languages.includes(film.language));
    // English says little: half of everything is in English.
    if (country && film.language !== "en") return `in the language of the ${country.folder} folder`;
    return null;
  };

  const scored = results
    .map((film) => {
      const asKnown: KnownFilm = { ...film, directed: false };
      return { film, close: closeness(claim, asKnown), year: yearFits(claim, asKnown), agreed: agrees(film) };
    })
    .filter((s) => s.close >= 1 && s.year !== "differs")
    .sort(
      (a, b) =>
        b.close - a.close ||
        Number(b.year === "same") - Number(a.year === "same") ||
        Number(b.agreed !== null) - Number(a.agreed !== null),
    );
  const top = scored[0];
  if (!top) return null;
  const when = top.film.year ? ` (${top.film.year})` : "";
  const strong = (s: (typeof scored)[number]) => s.close === 3 && s.year === "same" && s.agreed !== null;
  if (strong(top) && scored.filter(strong).length === 1) {
    return { film: top.film, certainty: "certain", why: `Same title and year${when}, and ${top.agreed}` };
  }
  return {
    film: top.film,
    certainty: "likely",
    why: `${top.close === 3 ? "Same title" : "A close title"}${when}${top.agreed ? `, ${top.agreed}` : ""}`,
  };
}
