/**
 * Shown the instant a navigation to /browse begins, including every sidebar
 * filter click (each of those is a real server navigation — see the comment
 * at the top of page.tsx about this page being URL-param-driven).
 *
 * Browse is the most expensive page in the app: it fetches the whole
 * catalogue from Jellyfin (~1.1 MB, 1159 items, ~355 ms warm and ~1.4 s cold
 * as measured 2026-08-28) and the 20-second catalogue cache means most real
 * navigations pay that again. Before this file existed there was no
 * loading.tsx anywhere in the app, so clicking a genre sat on the previous
 * page with no feedback whatsoever.
 *
 * The shape deliberately mirrors page.tsx's real markup (appbar, then
 * .browse-shell -> .browse-sidebar + .browse-main -> .grid) so the layout
 * does not shift when the real content replaces it.
 */
export default function BrowseLoading() {
  return (
    <div className="browse-skeleton" aria-busy="true" aria-live="polite">
      {/* AppBar is rendered by the page, not the layout, so it disappears
          during the transition unless the skeleton stands in for it. */}
      <div className="skeleton-appbar" />

      <span className="sr-only">Loading browse…</span>

      <div className="browse-shell">
        <aside className="browse-sidebar" aria-hidden="true">
          <div className="skeleton-block dim-tabs-skeleton" />
          <div className="skeleton-block search-skeleton" />
          {Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              className="skeleton-block value-row-skeleton"
              // Slight width variation reads as a list of real labels rather
              // than a stack of identical bars.
              style={{ width: `${70 + ((i * 13) % 30)}%` }}
            />
          ))}
        </aside>

        <main className="browse-main" aria-hidden="true">
          <div className="skeleton-block topbar-skeleton" />
          <div className="grid">
            {Array.from({ length: 18 }, (_, i) => (
              <div key={i} className="poster">
                <div className="skeleton-block poster-skeleton" />
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
