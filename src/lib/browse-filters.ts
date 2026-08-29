/**
 * Pure filtering logic for the Browse page.
 *
 * Deliberately kept free of ALL runtime imports — no `server-only`, no `./db`,
 * no Jellyfin client. That is what lets browse-filters.test.ts import it
 * directly under `node --test --experimental-strip-types`; browse-data.ts
 * cannot be imported that way (it pulls in `server-only` and the SQLite
 * handle), which is precisely why the decade bug below survived so long
 * unnoticed.
 *
 * Anything here must stay dependency-free. If you need library data, it
 * belongs in browse-data.ts, not this file.
 */

export type BrowseDim = "genre" | "director" | "actor" | "decade";
export type BrowseSort = "popularity" | "newest" | "oldest";

/**
 * The minimum shape filtering needs. BrowseMovie in browse-data.ts satisfies
 * this structurally, so no import (and no import cycle) is required.
 */
export interface FilterableMovie {
  year: number | null;
  genres: string[];
  directors: string[];
  actors: string[];
}

export function decadeOf(year: number | null): number | null {
  return year ? Math.floor(year / 10) * 10 : null;
}

/**
 * The canonical URL form of a decade facet: the bare decade ("1990"), NOT the
 * display form ("1990s").
 *
 * This distinction is the entire bug this module was extracted to fix. The
 * sidebar used to link `?value=1990s` (the facet's display *name*) while
 * filterMovies compared against `String(decadeOf(year))` = "1990" (the facet's
 * *id*), so selecting any decade silently matched nothing and Browse showed
 * "No films match this filter." The page title independently gave the game
 * away by rendering "1990ss", since it appends its own "s".
 *
 * parseDecade accepts BOTH forms, so links shared or bookmarked before the fix
 * keep working instead of quietly returning an empty grid.
 */
export function parseDecade(value: string): number | null {
  const m = /^(\d{3,4})s?$/.exec(value.trim());
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

export function filterMovies<T extends FilterableMovie>(
  movies: T[],
  dim: BrowseDim,
  value: string | null,
): T[] {
  if (value === null) return movies;

  if (dim === "genre") return movies.filter((m) => m.genres.includes(value));
  if (dim === "director") return movies.filter((m) => m.directors.includes(value));
  if (dim === "actor") return movies.filter((m) => m.actors.includes(value));

  if (dim === "decade") {
    const want = parseDecade(value);
    // An unparseable decade is a malformed URL, not "match everything" —
    // returning `movies` here would make a typo look like a working filter.
    if (want === null) return [];
    return movies.filter((m) => decadeOf(m.year) === want);
  }

  return movies;
}

/**
 * The URL `value` the sidebar must link for a given facet row.
 *
 * This exists so the id-vs-name decision is made in ONE tested place instead
 * of being inlined in the page's JSX. That inlining was the actual defect:
 * filterMovies was always correct for the id form, so a unit test calling it
 * directly with "1990" passed happily while the real page — which linked the
 * display name "1990s" — matched nothing. The bug lived in the wiring, not the
 * function, so the contract now lives next to the function that consumes it
 * and is covered by a round-trip test.
 */
export function facetLinkValue(facet: { id: string; name: string }): string {
  return facet.id;
}

/**
 * True when a facet row should render as the selected one. Accepts either the
 * id or the display name for the same tolerance reason as parseDecade: a
 * pre-fix `?value=1990s` link should still light up the 1990s row.
 */
export function isFacetSelected(
  facet: { id: string; name: string },
  dim: BrowseDim,
  value: string | null,
): boolean {
  if (value === null) return false;
  if (dim === "decade") {
    const want = parseDecade(value);
    return want !== null && facet.id === String(want);
  }
  return facet.id === value || facet.name === value;
}
