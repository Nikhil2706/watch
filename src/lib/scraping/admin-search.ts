import "server-only";

import { signResource } from "../crypto";
import { env } from "../env";
import { getAdminMovies } from "../admin-library-cache";
import { getGroupedPathMap, getGroupSeriesId, getGroupSeriesPoster } from "../library-curation";
import { normaliseTitle } from "../library-review";
import { itemHref } from "../slugs";

/**
 * A signed admin thumbnail URL — NOT the /jf/ path the public site uses.
 *
 * The console is a local file:// page: its <img> requests are cross-site, so
 * the session cookie /jf/ requires never travels, and an <img> cannot send the
 * X-Admin-Key header either. Signing the URL is what makes a library poster
 * displayable there at all. See src/app/api/admin/thumb/[itemId]/route.ts.
 */
function flatPosterUrl(id: string, tag: string | null | undefined): string | null {
  if (!tag) return null;
  const sig = signResource(`${id}:${tag}`, env.adminApiKey);
  const query = new URLSearchParams({ tag, sig });
  return `/api/admin/thumb/${encodeURIComponent(id)}?${query.toString()}`;
}

/**
 * A tiny admin-key-gated library search for the Accolades dashboard's
 * Builder slot search — distinct from /api/search/suggest, which requires a
 * user session (cookie auth) the curl-based admin surface doesn't have.
 *
 * A grouped TV show collapses to one hit, matched and named after the
 * show's own corrected title rather than whichever episode file Jellyfin
 * happens to iterate first — the same reasoning as collapseEpisodeGroups()
 * in media.ts, just without a Jellyfin session to call it from. A show with
 * no linked series IMDb id yet (getGroupSeriesId returns null) is skipped
 * here rather than surfaced with a dead-end id: the curator can still type
 * its raw title into a Builder slot, which resolves later the normal way.
 */
export interface AdminSearchHit {
  imdbId: string;
  name: string;
  year: number | null;
  /** "/item/{id}" for a movie, "/collection/{groupId}" for a show — lets a caller notify or link without a second lookup. */
  href: string;
  posterUrl: string | null;
}

export async function searchLibraryForAdmin(query: string, limit = 8): Promise<AdminSearchHit[]> {
  const key = normaliseTitle(query);
  if (!key) return [];

  // Light shape (no MediaSources) and cached: this runs on a keystroke
  // debounce, and nothing here needs a title's stream list.
  const movies = await getAdminMovies({ withMediaSources: false });
  const groupedPaths = getGroupedPathMap();
  const seenGroups = new Set<string>();
  const hits: AdminSearchHit[] = [];

  for (const movie of movies) {
    if (hits.length >= limit) break;

    const g = movie.Path ? groupedPaths.get(movie.Path) : undefined;
    if (g) {
      if (seenGroups.has(g.groupId)) continue;
      seenGroups.add(g.groupId);
      if (!normaliseTitle(g.groupName).includes(key)) continue;
      const imdbId = getGroupSeriesId(g.groupId);
      if (!imdbId) continue;
      // Best-effort only: this checks just the group's first-iterated member,
      // not every member the way browse-data.ts's full members-scan fallback
      // does (getGroupedPathMap doesn't expose a cheap members list here) —
      // fine for an admin picker that also shows a name/year caption.
      const groupPoster = getGroupSeriesPoster(g.groupId) ?? flatPosterUrl(movie.Id, movie.ImageTags?.Primary);
      hits.push({ imdbId, name: g.groupName, year: null, href: `/collection/${g.groupId}`, posterUrl: groupPoster });
      continue;
    }

    const imdbId = movie.ProviderIds?.Imdb;
    if (!imdbId) continue;
    if (!normaliseTitle(movie.Name).includes(key)) continue;
    hits.push({
      imdbId,
      name: movie.Name,
      year: movie.ProductionYear ?? null,
      href: itemHref(movie.Id, movie.Name, movie.ProductionYear),
      posterUrl: flatPosterUrl(movie.Id, movie.ImageTags?.Primary),
    });
  }
  return hits;
}
