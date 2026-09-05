import Link from "next/link";
import { redirect } from "next/navigation";

import { ExpandableBio } from "@/components/media/ExpandableBio";
import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import {
  buildBrowseData,
  facetLinkValue,
  filterMovies,
  isFacetSelected,
  sortMovies,
  type BrowseDim,
  type BrowseSort,
} from "@/lib/browse-data";
import { currentSession } from "@/lib/current-user";
import { getMemberships } from "@/lib/lists";
import { getPerson, personPhotoUrl } from "@/lib/media";

export const dynamic = "force-dynamic";

const DIMS: Array<{ id: BrowseDim; label: string; placeholder: string }> = [
  { id: "genre", label: "Genre", placeholder: "Search genres…" },
  { id: "director", label: "Director", placeholder: "Search directors…" },
  { id: "actor", label: "Actor", placeholder: "Search actors…" },
  { id: "decade", label: "Decade", placeholder: "Search decades…" },
];

const SORTS: Array<{ id: BrowseSort; label: string }> = [
  { id: "popularity", label: "Popularity" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
];

function isDim(value: string | undefined): value is BrowseDim {
  return value === "genre" || value === "director" || value === "actor" || value === "decade";
}
function isSort(value: string | undefined): value is BrowseSort {
  return value === "popularity" || value === "newest" || value === "oldest";
}

/**
 * Multi-dimensional Browse: genre / director / actor / decade, ranked by a
 * Bayesian-weighted popularity score rather than a bare average (see
 * browse-data.ts). Server-rendered and URL-param-driven (?dim=&value=&sort=&q=)
 * like the rest of this app, rather than a client-side SPA — a filter change
 * is a normal navigation, so back/forward and shareable links work for free.
 */
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ dim?: string; value?: string; sort?: string; q?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const dim: BrowseDim = isDim(params.dim) ? params.dim : "genre";
  const sort: BrowseSort = isSort(params.sort) ? params.sort : "popularity";
  const value = params.value ?? null;
  const search = (params.q ?? "").trim();

  const { catalogue, facets } = await buildBrowseData(session);
  const { movies, libraryMeanRating } = catalogue;

  const dimMeta = DIMS.find((d) => d.id === dim)!;
  const values = dim === "genre" ? facets.genres : dim === "decade" ? facets.decades : dim === "director" ? facets.directors : facets.actors;
  const filteredValues = search
    ? values.filter((v) => v.name.toLowerCase().includes(search.toLowerCase()))
    : values;

  const filtered = filterMovies(movies, dim, value);
  const sorted = sortMovies(filtered, sort, libraryMeanRating);

  const lists = getMemberships(
    session.userId,
    sorted.filter((m) => !m.isGroup).map((m) => m.item.Id),
  );

  // The person-head panel: only for a selected director/actor whose id
  // resolved to a real Jellyfin person (getPerson returns null harmlessly
  // for the name-fallback ids a group-only credit produces).
  const selectedPerson =
    (dim === "director" || dim === "actor") && value
      ? (dim === "director" ? facets.directors : facets.actors).find((p) => p.name === value)
      : null;
  const personDetail = selectedPerson ? await getPerson(session, selectedPerson.id).catch(() => null) : null;

  const baseQuery = (overrides: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    const merged = { dim, sort, value: value ?? undefined, q: search || undefined, ...overrides };
    for (const [key, v] of Object.entries(merged)) {
      if (v) qs.set(key, v);
    }
    const s = qs.toString();
    return s ? `/browse?${s}` : "/browse";
  };

  // Title comes from the matching facet's display name rather than being
  // reconstructed from the URL value. The old `${value}s` produced "1990ss"
  // once a decade link started passing the already-pluralised display name,
  // and would still misrender for any bookmarked pre-fix link.
  const selectedFacet =
    (dim === "genre" || dim === "decade") && value
      ? (dim === "genre" ? facets.genres : facets.decades).find((f) => isFacetSelected(f, dim, value))
      : null;

  let title = "Browse";
  if (value) {
    if (dim === "genre" || dim === "decade") title = selectedFacet?.name ?? value;
    else title = selectedPerson?.name ?? value;
  }

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <div className="browse-shell">
        <aside className="browse-sidebar">
          <nav className="dim-tabs">
            {DIMS.map((d) => (
              <Link
                key={d.id}
                href={baseQuery({ dim: d.id, value: undefined, q: undefined })}
                className={`dim-tab${dim === d.id ? " active" : ""}`}
              >
                {d.label}
              </Link>
            ))}
          </nav>

          <form className="sidebar-search" action="/browse" method="get">
            <input type="hidden" name="dim" value={dim} />
            <input type="hidden" name="sort" value={sort} />
            {/* This box filters the facet list in the sidebar, not the grid.
                Without carrying `value` through, typing here also silently
                cleared whatever genre/director was selected and reset the grid
                to the whole library — `dim` and `sort` were already preserved,
                so dropping only `value` was an oversight rather than intent. */}
            {value ? <input type="hidden" name="value" value={value} /> : null}
            <input
              type="text"
              name="q"
              placeholder={dimMeta.placeholder}
              defaultValue={search}
              spellCheck={false}
              autoComplete="off"
            />
          </form>

          <div className="value-list">
            <Link
              href={baseQuery({ value: undefined, q: undefined })}
              className={`value-row all-option${value === null ? " active" : ""}`}
            >
              All {dimMeta.label.toLowerCase()}s
            </Link>
            {filteredValues.length === 0 ? (
              <div className="value-empty">No {dimMeta.label.toLowerCase()}s match &ldquo;{search}&rdquo;.</div>
            ) : (
              (dim === "director" || dim === "actor"
                ? (filteredValues as typeof facets.directors).map((p) => (
                    <Link
                      key={p.id}
                      href={baseQuery({ value: p.name, q: undefined })}
                      className={`value-row${value === p.name ? " active" : ""}`}
                    >
                      <span className="avatar">
                        {p.photo ? (
                          <img src={p.photo} alt="" loading="lazy" />
                        ) : (
                          p.name
                            .split(/\s+/)
                            .slice(0, 2)
                            .map((w) => w[0] ?? "")
                            .join("")
                            .toUpperCase()
                        )}
                      </span>
                      <span className="vname">{p.name}</span>
                      <span className="vcount">{dim === "director" ? p.directorCount : p.actorCount}</span>
                    </Link>
                  ))
                : (filteredValues as typeof facets.genres).map((f) => (
                    <Link
                      key={f.id}
                      // Must go through facetLinkValue, not f.name. For genres
                      // the two are identical, but for decades id is "1990" and
                      // name is "1990s" — linking the display name made every
                      // decade filter match nothing. The id/name choice is a
                      // tested contract in browse-filters.ts; don't inline it.
                      href={baseQuery({ value: facetLinkValue(f), q: undefined })}
                      className={`value-row${isFacetSelected(f, dim, value) ? " active" : ""}`}
                    >
                      <span className="vname">{f.name}</span>
                      <span className="vcount">{f.count}</span>
                    </Link>
                  )))
            )}
          </div>
        </aside>

        <main className="browse-main">
          <div className="browse-topbar">
            <h1>{title}</h1>
            <span className="browse-count">
              {sorted.length} film{sorted.length === 1 ? "" : "s"}
            </span>
            <div className="spacer" />
            <div className="sort-group">
              {SORTS.map((s) => (
                <Link
                  key={s.id}
                  href={baseQuery({ sort: s.id })}
                  className={`sort-btn${sort === s.id ? " active" : ""}`}
                >
                  {s.label}
                </Link>
              ))}
            </div>
          </div>

          {selectedPerson ? (
            <section className="person-head">
              <div className="person-photo">
                {personDetail ? (
                  (() => {
                    const photo = personPhotoUrl(personDetail, 260);
                    return photo ? (
                      <img src={photo} alt="" decoding="async" />
                    ) : (
                      <span className="cast-initials">
                        {selectedPerson.name
                          .split(/\s+/)
                          .slice(0, 2)
                          .map((w) => w[0] ?? "")
                          .join("")
                          .toUpperCase()}
                      </span>
                    );
                  })()
                ) : (
                  <span className="cast-initials">
                    {selectedPerson.name
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((w) => w[0] ?? "")
                      .join("")
                      .toUpperCase()}
                  </span>
                )}
              </div>
              <div className="person-text">
                <h2>{selectedPerson.name}</h2>
                <p className="person-count">
                  {sorted.length} film{sorted.length === 1 ? "" : "s"} in this library
                </p>
                {personDetail?.Overview ? (
                  <ExpandableBio text={personDetail.Overview} />
                ) : null}
              </div>
            </section>
          ) : null}

          {sorted.length === 0 ? (
            <div className="empty">No films match this filter.</div>
          ) : (
            <div className="grid">
              {sorted.map((m) =>
                m.isGroup ? (
                  <PosterCard
                    key={m.item.Id}
                    item={m.item}
                    href={m.href}
                    posterSrc={m.poster ?? null}
                    partsCount={m.partsCount}
                    partsUnit={m.partsUnit}
                  />
                ) : (
                  <PosterCard key={m.item.Id} item={m.item} lists={lists.get(m.item.Id)} />
                ),
              )}
            </div>
          )}
        </main>
      </div>
    </>
  );
}
