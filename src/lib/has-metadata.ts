/**
 * Does this title have any metadata at all?
 *
 * The rule governs two things that must agree: whether a title is hidden from
 * viewers (filterVisible in media.ts) and whether it lands in the curator's
 * review queue (library-review.ts). Those were two identical copies over two
 * differently-named types, with nothing keeping them in step.
 *
 * A title with no overview, no TMDB id and no IMDb id is an open question for
 * the review dashboard rather than something to hand a viewer — which is why
 * an explicit whitelist entry overrides it at the call site.
 *
 * Structural parameter type, so both the viewer-facing MediaItem and the
 * admin-facing AdminMovieListItem satisfy it without either importing the
 * other. No server-only import, so it is testable.
 */
export interface MetadataBearing {
  Overview?: string | null;
  ProviderIds?: Record<string, string> | null;
}

export function hasNoMetadata(item: MetadataBearing): boolean {
  return !item.Overview && !item.ProviderIds?.Tmdb && !item.ProviderIds?.Imdb;
}
