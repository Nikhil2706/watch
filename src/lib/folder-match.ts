import "server-only";

import { getAdminMovies } from "./admin-library-cache";
import { asRow, asRows, getDb } from "./db";
import { env } from "./env";
import { versionedPathMap } from "./film-versions";
import {
  claimedTitle,
  folderHints,
  folderNamesPerson,
  matchAmongFilms,
  matchAmongSearch,
  type Certainty,
  type FolderHint,
  type KnownFilm,
} from "./folder-sense";
import { hasNoMetadata } from "./has-metadata";
import { remoteSearchMovie, type RemoteSearchResult } from "./jellyfin";
import { getExcludedPathSet, getGroupedPathMap, getWhitelistedPathSet } from "./library-curation";
import { applyLibraryMatch } from "./library-match";
import { ownedMovieTmdbIds } from "./tmdb-person";
import { fetchPerson, searchMovies, searchPeople } from "./tmdb-store";

/**
 * Identifying files from the folders they were filed in.
 *
 * The rules are folder-sense.ts. This is the part that knows the library:
 * which files nobody has identified, who directed the films already sitting
 * in a folder (which is how "Luca Guadanino" is known to mean Luca
 * Guadagnino without asking anybody), and what that person made.
 *
 * A match that is certain is applied; anything less is kept as a suggestion
 * for the console to ask about. A suggestion that was turned down is
 * remembered, so the same wrong guess is not offered again.
 */

export interface FolderSuggestion {
  path: string;
  itemId: string;
  /** What the library calls the file now. */
  name: string;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  certainty: Certainty;
  why: string;
  status: "open" | "applied" | "dismissed" | "failed";
  createdAt: number;
  decidedAt: number | null;
}

interface SuggestionRow {
  path: string;
  item_id: string;
  name: string;
  tmdb_id: number;
  title: string;
  year: number | null;
  poster_path: string | null;
  certainty: Certainty;
  why: string;
  status: FolderSuggestion["status"];
  created_at: number;
  decided_at: number | null;
}

const toSuggestion = (r: SuggestionRow): FolderSuggestion => ({
  path: r.path,
  itemId: r.item_id,
  name: r.name,
  tmdbId: r.tmdb_id,
  title: r.title,
  year: r.year,
  posterPath: r.poster_path,
  certainty: r.certainty,
  why: r.why,
  status: r.status,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

function getRow(path: string): SuggestionRow | null {
  return asRow<SuggestionRow>(getDb().prepare("SELECT * FROM folder_match_suggestions WHERE path = ?").get(path)) ?? null;
}

function setStatus(path: string, status: FolderSuggestion["status"]): void {
  getDb()
    .prepare("UPDATE folder_match_suggestions SET status = ?, decided_at = ? WHERE path = ?")
    .run(status, Date.now(), path);
}

/** What the console shows: everything waiting for an answer, and the last few applied unasked. */
export function listFolderSuggestions(): { open: FolderSuggestion[]; applied: FolderSuggestion[] } {
  const db = getDb();
  return {
    open: asRows<SuggestionRow>(
      db.prepare("SELECT * FROM folder_match_suggestions WHERE status IN ('open', 'failed') ORDER BY path").all(),
    ).map(toSuggestion),
    applied: asRows<SuggestionRow>(
      db
        .prepare("SELECT * FROM folder_match_suggestions WHERE status = 'applied' ORDER BY decided_at DESC LIMIT 30")
        .all(),
    ).map(toSuggestion),
  };
}

/* ------------------------------------------------------------------ *
 * Who a folder is named after, and what they made
 * ------------------------------------------------------------------ */

interface FolderPerson {
  tmdbId: number;
  name: string;
}

/** Every director credit on an identified file: where the file is, and whose it is. */
function directorCredits(): Array<{ path: string; tmdbId: number; name: string }> {
  return asRows<{ path: string; tmdb_id: number; name: string }>(
    getDb()
      .prepare(
        `SELECT c.subject_id AS path, p.tmdb_id, p.name
           FROM tmdb_credits c
           JOIN tmdb_people p ON p.tmdb_id = c.tmdb_person_id
          WHERE c.subject_type = 'path' AND c.department = 'directors'`,
      )
      .all(),
  ).map((r) => ({ path: r.path, tmdbId: r.tmdb_id, name: r.name }));
}

/**
 * The people a folder is named after.
 *
 * First from the library itself: whoever directed films already in the
 * folder and whose name the folder's resembles. That needs no request and
 * reads a misspelt folder correctly, because the films in it say who was
 * meant. Only a folder with nothing identified in it yet is searched for on
 * TMDB by name. More than one person is a real answer ("Safdie").
 */
async function peopleOfFolder(
  hint: Extract<FolderHint, { kind: "name" }>,
  credits: ReturnType<typeof directorCredits>,
): Promise<FolderPerson[]> {
  const counts = new Map<number, { person: FolderPerson; films: number }>();
  for (const credit of credits) {
    if (!credit.path.startsWith(hint.path + "/")) continue;
    if (!folderNamesPerson(hint.folder, credit.name)) continue;
    const entry = counts.get(credit.tmdbId) ?? { person: { tmdbId: credit.tmdbId, name: credit.name }, films: 0 };
    entry.films += 1;
    counts.set(credit.tmdbId, entry);
  }
  if (counts.size > 0) {
    return [...counts.values()]
      .sort((a, b) => b.films - a.films)
      .slice(0, 3)
      .map((c) => c.person);
  }

  const found = await searchPeople(hint.folder).catch(() => []);
  const named = found.filter((p) => folderNamesPerson(hint.folder, p.name));
  const pick = named.find((p) => p.department === "Directing") ?? named[0];
  return pick ? [{ tmdbId: pick.id, name: pick.name }] : [];
}

interface PersonCreditsPayload {
  movie_credits?: {
    crew?: Array<{ id: number; title?: string; original_title?: string; release_date?: string; job?: string; poster_path?: string | null }>;
    cast?: Array<{ id: number; title?: string; original_title?: string; release_date?: string; poster_path?: string | null }>;
  };
}

type FilmWithPoster = KnownFilm & { posterPath: string | null };

/** Everything one person is credited on, each film once, marked when they directed it. */
async function filmsOf(person: FolderPerson): Promise<FilmWithPoster[]> {
  const payload = (await fetchPerson(person.tmdbId)).payload as PersonCreditsPayload;
  const films = new Map<number, FilmWithPoster>();
  const add = (
    c: { id: number; title?: string; original_title?: string; release_date?: string; poster_path?: string | null },
    directed: boolean,
  ) => {
    if (!c.title) return;
    const known = films.get(c.id);
    if (known) {
      known.directed = known.directed || directed;
      return;
    }
    films.set(c.id, {
      tmdbId: c.id,
      title: c.title,
      originalTitle: c.original_title ?? null,
      year: c.release_date ? Number(c.release_date.slice(0, 4)) || null : null,
      directed,
      posterPath: c.poster_path ?? null,
    });
  };
  for (const c of payload.movie_credits?.crew ?? []) add(c, c.job === "Director" || c.job === "Co-Director");
  for (const c of payload.movie_credits?.cast ?? []) add(c, false);
  return [...films.values()];
}

/* ------------------------------------------------------------------ *
 * One file
 * ------------------------------------------------------------------ */

interface Found {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  certainty: Certainty;
  why: string;
}

interface RunMemo {
  credits: ReturnType<typeof directorCredits>;
  people: Map<string, Promise<FolderPerson[]>>;
  films: Map<number, Promise<FilmWithPoster[]>>;
  owned: Set<number>;
}

async function findForPath(path: string, memo: RunMemo): Promise<Found | null> {
  const hints = folderHints(path, env.mediaLibraryPath);

  // The nearest folder that names somebody decides it. A folder further up
  // that also does ("Italian/Mario Bava") only ever agrees.
  for (const hint of hints) {
    if (hint.kind !== "name") continue;
    if (!memo.people.has(hint.path)) memo.people.set(hint.path, peopleOfFolder(hint, memo.credits));
    const people = await memo.people.get(hint.path)!;
    if (people.length === 0) continue;

    const claim = claimedTitle(path, [hint.folder, ...people.map((p) => p.name)]);
    for (const person of people) {
      if (!memo.films.has(person.tmdbId)) memo.films.set(person.tmdbId, filmsOf(person));
      const films = await memo.films.get(person.tmdbId)!.catch(() => [] as FilmWithPoster[]);
      const match = matchAmongFilms(claim, films, person.name);
      if (!match) continue;
      const film = match.film as FilmWithPoster;
      // A second copy of something already here is a decision for a person.
      const here = memo.owned.has(film.tmdbId);
      return {
        tmdbId: film.tmdbId,
        title: film.title,
        year: film.year,
        posterPath: film.posterPath,
        certainty: here ? "likely" : match.certainty,
        why: `${match.why}. Folder: ${hint.folder}${here ? ". That film is already in the library" : ""}`,
      };
    }
    // Their folder, but none of their films: say nothing rather than fall
    // through to a search that would find a stranger's film of that name.
    return null;
  }

  const claim = claimedTitle(path, []);
  const title = claim.titles[0];
  if (!title) return null;
  const results = await searchMovies(title, claim.year).catch(() => []);
  const match = matchAmongSearch(claim, results, hints);
  if (!match) return null;
  const here = memo.owned.has(match.film.tmdbId);
  return {
    tmdbId: match.film.tmdbId,
    title: match.film.title,
    year: match.film.year,
    posterPath: results.find((r) => r.tmdbId === match.film.tmdbId)?.posterPath ?? null,
    certainty: here ? "likely" : match.certainty,
    why: `${match.why}${here ? ". That film is already in the library" : ""}`,
  };
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

/**
 * Jellyfin's own candidate for a TMDB id, which is what its Apply wants.
 * Asked up to three times: from this network the connection to TheMovieDb is
 * cut more often than not, and a cut attempt returns nothing in under a
 * second (see the identify route).
 */
async function candidateFor(itemId: string, s: { tmdbId: number; title: string; year: number | null }): Promise<RemoteSearchResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await remoteSearchMovie(itemId, s.title, s.year ?? undefined, { Tmdb: String(s.tmdbId) }).catch(() => []);
    const exact = found.find((c) => c.ProviderIds?.Tmdb === String(s.tmdbId));
    if (exact) return exact;
  }
  throw new Error("TheMovieDb did not answer for that film.");
}

async function apply(row: SuggestionRow, confirmed: boolean): Promise<void> {
  const candidate = await candidateFor(row.item_id, { tmdbId: row.tmdb_id, title: row.title, year: row.year });
  await applyLibraryMatch(row.item_id, candidate, {
    confirmPath: confirmed ? row.path : null,
    knownPath: row.path,
    resolvedBy: "folder-match",
  });
  setStatus(row.path, "applied");
}

/** The console's "Yes, that's it". */
export async function acceptFolderSuggestion(path: string): Promise<FolderSuggestion> {
  const row = getRow(path);
  if (!row || row.status === "applied") throw new Error("That suggestion is no longer open.");
  await apply(row, true);
  return toSuggestion(getRow(path)!);
}

/** The console's "No". Kept, so the same film is not offered for this file again. */
export function dismissFolderSuggestion(path: string): boolean {
  const row = getRow(path);
  if (!row || row.status === "applied") return false;
  setStatus(path, "dismissed");
  return true;
}

/* ------------------------------------------------------------------ *
 * The pass
 * ------------------------------------------------------------------ */

export interface FolderMatchRun {
  /** Files with no metadata and no decision made about them. */
  looked: number;
  applied: number;
  suggested: number;
  failed: number;
}

const g = globalThis as { __folderMatchRunning?: Promise<FolderMatchRun> | null };

export function folderMatchRunning(): boolean {
  return !!g.__folderMatchRunning;
}

/**
 * Looks at every unidentified file and works out what its folders say.
 *
 * `apply` false is a dry run: suggestions are stored, certain ones included,
 * and nothing in Jellyfin changes. One pass at a time; a second caller gets
 * the result of the one already running.
 */
export function runFolderMatch(options: { apply: boolean }): Promise<FolderMatchRun> {
  if (g.__folderMatchRunning) return g.__folderMatchRunning;
  const run = pass(options).finally(() => {
    g.__folderMatchRunning = null;
  });
  g.__folderMatchRunning = run;
  return run;
}

async function pass(options: { apply: boolean }): Promise<FolderMatchRun> {
  const db = getDb();
  const all = await getAdminMovies();
  const excluded = getExcludedPathSet();
  const grouped = getGroupedPathMap();
  const whitelisted = getWhitelistedPathSet();
  const versioned = versionedPathMap();
  const targets = all.filter(
    (m) =>
      !!m.Path &&
      hasNoMetadata(m) &&
      !excluded.has(m.Path) &&
      !grouped.has(m.Path) &&
      !whitelisted.has(m.Path) &&
      !versioned.has(m.Path),
  );

  // A file identified some other way since it was suggested needs no answer.
  const open = new Set(targets.map((m) => m.Path!));
  for (const row of asRows<{ path: string }>(
    db.prepare("SELECT path FROM folder_match_suggestions WHERE status IN ('open', 'failed')").all(),
  )) {
    if (!open.has(row.path)) db.prepare("DELETE FROM folder_match_suggestions WHERE path = ?").run(row.path);
  }

  const memo: RunMemo = { credits: directorCredits(), people: new Map(), films: new Map(), owned: ownedMovieTmdbIds() };
  const result: FolderMatchRun = { looked: targets.length, applied: 0, suggested: 0, failed: 0 };

  for (const item of targets) {
    const path = item.Path!;
    const before = getRow(path);
    let found: Found | null = null;
    try {
      found = await findForPath(path, memo);
    } catch (error) {
      console.error(`[folder-match] ${path}:`, error);
    }
    if (!found) continue;
    // Two files that are the same film ("Ein Bild" and "An Image", one film
    // under its two names): the first is matched, the second is a second
    // copy, which is for a person to decide.
    if (memo.owned.has(found.tmdbId) && found.certainty === "certain") {
      found = { ...found, certainty: "likely", why: `${found.why}. Another file here is already matched to that film` };
    }
    memo.owned.add(found.tmdbId);
    // Turned down once: not offered again, and never applied over the "No".
    if (before?.status === "dismissed" && before.tmdb_id === found.tmdbId) continue;

    db.prepare(
      `INSERT INTO folder_match_suggestions
         (path, item_id, name, tmdb_id, title, year, poster_path, certainty, why, status, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL)
       ON CONFLICT(path) DO UPDATE SET
         item_id = excluded.item_id, name = excluded.name, tmdb_id = excluded.tmdb_id, title = excluded.title,
         year = excluded.year, poster_path = excluded.poster_path, certainty = excluded.certainty,
         why = excluded.why, status = 'open', decided_at = NULL`,
    ).run(path, item.Id, item.Name, found.tmdbId, found.title, found.year, found.posterPath, found.certainty, found.why, Date.now());

    // A dismissed file whose folders now point at a different film is asked
    // about again, never applied: somebody has already said no here once.
    if (options.apply && found.certainty === "certain" && before?.status !== "dismissed") {
      try {
        await apply(getRow(path)!, false);
        result.applied += 1;
        continue;
      } catch (error) {
        console.error(`[folder-match] could not apply ${found.title} to ${path}:`, error);
        setStatus(path, "failed");
        result.failed += 1;
        continue;
      }
    }
    result.suggested += 1;
  }
  return result;
}
