import "server-only";

import { asRows, getDb, transaction } from "./db";
import { guessVersionLabel } from "./version-label";

/**
 * Cuts of one film: a theatrical and a director's cut, an Italian and an
 * English version. Jellyfin files them as separate films (they are in
 * separate folders), and the review dashboard called them duplicates to hide.
 *
 * A version set is rows in film_versions sharing a primary_path. The site
 * lists only the primary; every version keeps its own page, Play, resume
 * position and offline copy, and each page offers the others (see the item
 * page's version picker). Nothing on disk moves.
 */

export interface FilmVersion {
  path: string;
  primaryPath: string;
  label: string;
  position: number;
  isPrimary: boolean;
}

interface Row {
  path: string;
  primary_path: string;
  label: string;
  position: number;
}

const toVersion = (r: Row): FilmVersion => ({
  path: r.path,
  primaryPath: r.primary_path,
  label: r.label,
  position: r.position,
  isPrimary: r.path === r.primary_path,
});

/** Paths hidden from listings: every version that isn't its set's primary. */
export function getAlternateVersionPathSet(): Set<string> {
  return new Set(
    asRows<{ path: string }>(getDb().prepare("SELECT path FROM film_versions WHERE path <> primary_path").all()).map(
      (r) => r.path,
    ),
  );
}

/** The whole set a file belongs to, primary first; empty when it's in none. */
export function versionSetForPath(path: string): FilmVersion[] {
  return asRows<Row>(
    getDb()
      .prepare(
        `SELECT path, primary_path, label, position FROM film_versions
          WHERE primary_path = (SELECT primary_path FROM film_versions WHERE path = ?)
          ORDER BY (path = primary_path) DESC, position ASC`,
      )
      .all(path),
  ).map(toVersion);
}

/** Every set, for the console. */
export function listVersionSets(): FilmVersion[][] {
  const sets = new Map<string, FilmVersion[]>();
  for (const r of asRows<Row>(
    getDb().prepare("SELECT path, primary_path, label, position FROM film_versions ORDER BY primary_path, position").all(),
  )) {
    const v = toVersion(r);
    const list = sets.get(v.primaryPath) ?? [];
    if (v.isPrimary) list.unshift(v);
    else list.push(v);
    sets.set(v.primaryPath, list);
  }
  return [...sets.values()];
}

/**
 * Makes these files one film with `primaryPath` as the one listed. Files
 * already in another set are moved into this one; labels already chosen are
 * kept, new ones guessed from the filename ("Version 2" when it says nothing).
 */
export function createVersionSet(primaryPath: string, otherPaths: readonly string[]): FilmVersion[] {
  const paths = [primaryPath, ...otherPaths.filter((p) => p !== primaryPath)];
  if (paths.length < 2) throw new Error("a version set needs at least two files");
  const now = Date.now();
  transaction((db) => {
    const existing = new Map(
      asRows<{ path: string; label: string }>(
        db.prepare(`SELECT path, label FROM film_versions WHERE path IN (${paths.map(() => "?").join(",")})`).all(...paths),
      ).map((r) => [r.path, r.label]),
    );
    // Beside a director's, extended or uncut version, the plain one is the
    // theatrical cut; otherwise it's just the original.
    const guesses = paths.map((p) => guessVersionLabel(p));
    const longerCut = guesses.some((g) => g === "Director's cut" || g === "Extended" || g === "Uncut" || g === "Unrated");
    paths.forEach((path, position) => {
      const label =
        existing.get(path) ??
        guesses[position] ??
        (position === 0 ? (longerCut ? "Theatrical" : "Original") : `Version ${position + 1}`);
      db.prepare(
        `INSERT INTO film_versions (path, primary_path, label, position, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET primary_path = excluded.primary_path, position = excluded.position`,
      ).run(path, primaryPath, label, position, now);
    });
  });
  return versionSetForPath(primaryPath);
}

export function setVersionLabel(path: string, label: string): boolean {
  const trimmed = label.trim().slice(0, 60);
  if (!trimmed) throw new Error("a version needs a name");
  return getDb().prepare("UPDATE film_versions SET label = ? WHERE path = ?").run(trimmed, path).changes > 0;
}

/** Lists this file instead of the current primary. */
export function makePrimaryVersion(path: string): boolean {
  return transaction((db) => {
    const row = db.prepare("SELECT primary_path FROM film_versions WHERE path = ?").get(path) as
      | { primary_path: string }
      | undefined;
    if (!row) return false;
    db.prepare("UPDATE film_versions SET primary_path = ? WHERE primary_path = ?").run(path, row.primary_path);
    return true;
  });
}

/**
 * Takes a file out of its set; it becomes a film of its own again. A set left
 * with one file dissolves, and one that loses its primary promotes the next.
 */
export function removeFromVersionSet(path: string): boolean {
  return transaction((db) => {
    const row = db.prepare("SELECT primary_path FROM film_versions WHERE path = ?").get(path) as
      | { primary_path: string }
      | undefined;
    if (!row) return false;
    db.prepare("DELETE FROM film_versions WHERE path = ?").run(path);
    const rest = asRows<{ path: string }>(
      db.prepare("SELECT path FROM film_versions WHERE primary_path = ? ORDER BY position").all(row.primary_path),
    );
    if (rest.length < 2) {
      db.prepare("DELETE FROM film_versions WHERE primary_path = ?").run(row.primary_path);
    } else if (path === row.primary_path) {
      db.prepare("UPDATE film_versions SET primary_path = ? WHERE primary_path = ?").run(rest[0]!.path, row.primary_path);
    }
    return true;
  });
}

export interface VersionLink {
  itemId: string;
  label: string;
  isPrimary: boolean;
}

/**
 * The set this file is in, as Jellyfin items to link to — or [] when it's in
 * none. A version whose file has gone from the library is left out rather
 * than linked to nothing.
 */
export async function versionLinksForPath(path: string): Promise<VersionLink[]> {
  const set = versionSetForPath(path);
  if (set.length < 2) return [];
  const { getAdminMovies } = await import("./admin-library-cache");
  const idByPath = new Map((await getAdminMovies({ withMediaSources: false })).map((m) => [m.Path, m.Id]));
  const links: VersionLink[] = [];
  for (const v of set) {
    const itemId = idByPath.get(v.path);
    if (itemId) links.push({ itemId, label: v.label, isPrimary: v.isPrimary });
  }
  return links.length > 1 ? links : [];
}

/** path → its place in a set, for the review dashboard. */
export function versionedPathMap(): Map<string, { label: string; isPrimary: boolean; setSize: number }> {
  const out = new Map<string, { label: string; isPrimary: boolean; setSize: number }>();
  for (const set of listVersionSets()) {
    for (const v of set) out.set(v.path, { label: v.label, isPrimary: v.isPrimary, setSize: set.length });
  }
  return out;
}
