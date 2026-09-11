/**
 * "30 of their 41 films are here" — for directors only.
 *
 * Directors only, by decision. An actor's or an editor's other work is mostly
 * other people's films and says little about this library; a director's
 * filmography is the unit a film club actually collects by. It also keeps the
 * cost down, because TMDB is only asked for the filmographies of people whose
 * pages show this list.
 *
 * Pure and importless like the other leaves, so it is tested directly.
 */

export interface GapFilm {
  tmdbId: number;
  title: string;
  year: number | null;
  posterUrl: string | null;
}

export interface DirectorGaps {
  /** Released films of theirs that are in the library. */
  owned: number;
  /** Released films of theirs, owned or not. */
  total: number;
  /** The ones that are not here, earliest first, capped for a single row. */
  missing: GapFilm[];
}

export function directorGaps(
  directed: readonly GapFilm[],
  ownedTmdbIds: ReadonlySet<number>,
  currentYear: number,
  limit = 24,
): DirectorGaps {
  // Nobody "does not have" a film that has not come out yet, so an announced
  // title with a future date counts toward neither number.
  const released = directed.filter((f) => f.year === null || f.year <= currentYear);
  const missing = released.filter((f) => !ownedTmdbIds.has(f.tmdbId));
  return {
    owned: released.length - missing.length,
    total: released.length,
    missing: missing.slice(0, limit),
  };
}
