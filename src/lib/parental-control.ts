import "server-only";

import { getCachedContentWarning } from "./content-warnings";

/**
 * "Stop showing R-rated or equivalent movies" — a per-user, gate-side
 * content filter, toggled per account from the curator's Users panel (see
 * /api/admin/users/:id). Deliberately not a Jellyfin-side policy change like
 * langlois_mode: this only decides what this app shows a viewer, which is a
 * simpler and more direct fit for "hide these from the listings and refuse
 * direct access" than trying to express the same thing as a Jellyfin parental
 * rating policy would be.
 *
 * Two independent signals feed the decision, because Jellyfin's own
 * OfficialRating alone has a real gap: most of this library's arthouse and
 * foreign titles never went through the MPAA at all, so "Unrated" covers
 * both "nothing objectionable" and "never submitted for rating" with no way
 * to tell them apart from the rating field alone.
 *
 *  1. isRestrictedRating() — the US/TV rating, when Jellyfin has one at all.
 *  2. content-warnings.ts's cache — TMDB certifications checked across
 *     EVERY country TMDB has data for (not just the US), plus TMDB's
 *     content-descriptor keywords. Populated by a background backfill (see
 *     content-warnings.ts), not fetched live — see isRestrictedContent()
 *     below for what happens before that backfill has reached a title.
 *
 * Honest limitation, worth stating plainly: neither signal is complete.
 * A title with no MPAA-equivalent rating ANYWHERE and no TMDB
 * certification/keyword data at all will read as "not restricted" even if
 * it genuinely contains exactly the content this feature exists to hide —
 * there is no automated source that reliably closes that gap for obscure
 * titles. This raises the floor well above "MPAA rating only"; it is not a
 * guarantee.
 */

const RESTRICTED_RATINGS = new Set(["R", "NC-17", "NC17", "X", "XXX", "TV-MA"]);

export function isRestrictedRating(rating: string | null | undefined): boolean {
  if (!rating) return false;
  return RESTRICTED_RATINGS.has(rating.trim().toUpperCase());
}

/**
 * The real check used everywhere filtering actually happens (media.ts). Only
 * reads the TMDB signal from the local cache — never fetches live, so this
 * stays a cheap synchronous call on every listing/item request. A title the
 * backfill hasn't reached yet simply falls back to the rating check alone,
 * same as before this cache existed.
 */
export function isRestrictedContent(item: {
  OfficialRating?: string | null;
  ProviderIds?: { Imdb?: string };
}): boolean {
  if (isRestrictedRating(item.OfficialRating)) return true;

  const imdbId = item.ProviderIds?.Imdb;
  if (!imdbId) return false;

  const cached = getCachedContentWarning(imdbId);
  return cached?.restricted === true;
}
