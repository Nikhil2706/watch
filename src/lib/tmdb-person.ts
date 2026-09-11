import "server-only";

import { asRows, getDb } from "./db";
import { fetchPerson, getCached } from "./tmdb-store";
import { personViewByTmdbId, type PersonView } from "./tmdb-view";

/**
 * A TMDB person for a page render, without ever making the render wait.
 *
 * The obvious version — fetch the person if they are not cached, then render —
 * would put a page load behind this host's link to TMDB, which drops about one
 * request in thirty and retries three times at up to fifteen seconds each. A
 * person page is not worth a forty-five-second stall. So a cached person is
 * used immediately, and a missing or old one is fetched in the background: the
 * first visit renders without the biography, and every visit after has it.
 *
 * Same shape as the photo cache — filled by being looked at, never by a sweep.
 */

/** Biographies and filmographies change slowly; a quarter is plenty fresh. */
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * People with a fetch already running, so a page opened twice in quick
 * succession does not start two requests for the same person.
 */
const inFlight = new Set<number>();

export function personForPage(tmdbId: number): PersonView | null {
  if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null;

  const cached = getCached("person", tmdbId);
  const fresh = cached !== null && Date.now() - cached.fetchedAt < STALE_MS;
  if (!fresh && !inFlight.has(tmdbId)) {
    inFlight.add(tmdbId);
    // Deliberately not awaited. A failure leaves the page as it would have been
    // with no TMDB data at all, and the next visit simply tries again.
    void fetchPerson(tmdbId, cached !== null)
      .catch(() => undefined)
      .finally(() => inFlight.delete(tmdbId));
  }
  return cached ? personViewByTmdbId(tmdbId) : null;
}

/** Every TMDB film id the library owns, for "which of theirs are here". */
export function ownedMovieTmdbIds(): Set<number> {
  return new Set(
    asRows<{ tmdb_id: number }>(
      getDb()
        .prepare(
          `SELECT DISTINCT tmdb_id FROM tmdb_links
            WHERE subject_type = 'path' AND tmdb_kind = 'movie' AND tmdb_id > 0`,
        )
        .all(),
    ).map((r) => r.tmdb_id),
  );
}

/**
 * Did this person direct anything in the library?
 *
 * The test for whether a page gets the "not in the library" row. Grounded in
 * the library rather than in TMDB's "known for" field on purpose: someone known
 * mainly as an actor who also directed a film you own is a director as far as
 * this library is concerned, and a famous director with nothing here has no
 * reason to be browsed as one.
 */
export function directsHere(tmdbId: number): boolean {
  const rows = asRows<{ n: number }>(
    getDb()
      .prepare(
        `SELECT 1 AS n FROM tmdb_credits
          WHERE tmdb_person_id = ? AND department = 'directors' LIMIT 1`,
      )
      .all(tmdbId),
  );
  return rows.length > 0;
}
