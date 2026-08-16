import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { CommunitySection } from "@/components/media/CommunitySection";
import { PosterCard } from "@/components/media/PosterCard";
import { RatingsRow } from "@/components/media/RatingsRow";
import { getRatingSummary } from "@/lib/community";
import { currentSession } from "@/lib/current-user";
import { getGroupSeriesId } from "@/lib/library-curation";
import { getMemberships } from "@/lib/lists";
import { getCollection } from "@/lib/media";

export const dynamic = "force-dynamic";

/**
 * The contents of one Collection — a multi-part film or mini-series grouped
 * from the library review dashboard, shown as a season-style grid of its
 * parts rather than as separate entries cluttering the main browse grid.
 *
 * Genres/cast/crew/ratings here all come from the SHOW's own OMDb entry
 * (set from the dashboard's "Manage" panel), never from any one episode's
 * — the group itself isn't a Jellyfin item, so unlike an episode's own
 * detail page, this one has to build its own header from scratch.
 */
export default async function CollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const collection = await getCollection(session, id);
  if (!collection) notFound();

  const lists = getMemberships(
    session.userId,
    collection.items.map(({ item }) => item.Id),
  );

  const partsLabel = `${collection.items.length} part${collection.items.length === 1 ? "" : "s"}`;
  const creators = collection.director.length > 0 ? collection.director : collection.writer;
  const creatorsLabel = collection.director.length > 0 ? "Directed by" : "Created by";

  // Comments/ratings key off the SHOW's own IMDb id, same as getRatings()
  // already does inside getCollection() — not any one episode's. Absent
  // until the group has been linked to a real series (curator dashboard's
  // "Link series"), same as collection.ratings itself.
  const seriesImdbId = getGroupSeriesId(id);
  const ratingSummary = seriesImdbId ? getRatingSummary(seriesImdbId) : null;
  const usRating = ratingSummary && ratingSummary.count > 0 ? { average: ratingSummary.average!, count: ratingSummary.count } : null;

  return (
    <>
      <AppBar username={session.username} />

      {/* The real series poster, once the admin has linked one — otherwise
          a plain text header rather than guessing at a background. */}
      {collection.posterSrc ? (
        <section className="hero">
          <div
            className="hero-bg"
            style={{ backgroundImage: `url("${collection.posterSrc}")` }}
            aria-hidden="true"
          />
          <div className="hero-content">
            <h1>{collection.Name}</h1>
            <div className="meta">
              <span>{partsLabel}</span>
              {collection.ratings?.imdb ? (
                <span className="meta-rating">
                  <span className="mark mark-imdb">IMDb</span>
                  {collection.ratings.imdb}
                </span>
              ) : null}
            </div>
            {collection.Overview ? <p>{collection.Overview}</p> : null}
          </div>
        </section>
      ) : (
        <div className="page-head">
          <h1>{collection.Name}</h1>
          {collection.Overview ? <p className="page-sub">{collection.Overview}</p> : null}
          <p className="page-sub">{partsLabel}</p>
        </div>
      )}

      <div className="detail-body">
        {collection.genres.length > 0 ? (
          <div className="chip-line">
            {collection.genres.map((g) => (
              <Link key={g} className="chip" href={`/browse?dim=genre&value=${encodeURIComponent(g)}`}>
                {g}
              </Link>
            ))}
          </div>
        ) : null}

        <RatingsRow ratings={collection.ratings} usRating={usRating} />

        {collection.actors.length > 0 ? (
          <div className="subtitle-line">
            <span className="subtitle-label">Starring</span>
            <span>{collection.actors.join(", ")}</span>
          </div>
        ) : null}
        {creators.length > 0 ? (
          <div className="subtitle-line">
            <span className="subtitle-label">{creatorsLabel}</span>
            <span>{creators.join(", ")}</span>
          </div>
        ) : null}
      </div>

      {collection.items.length === 0 ? (
        <div className="empty">Nothing in this collection.</div>
      ) : (
        <div className="grid">
          {collection.items.map(({ item, label }) => (
            <PosterCard key={item.Id} item={item} lists={lists.get(item.Id)} title={label ?? undefined} />
          ))}
        </div>
      )}

      {seriesImdbId ? (
        <div className="detail-body" style={{ marginTop: 28 }}>
          <CommunitySection
            imdbId={seriesImdbId}
            filmTitle={collection.Name}
            filmHref={`/collection/${id}`}
            currentUserId={session.userId}
            currentUsername={session.username}
          />
        </div>
      ) : null}
    </>
  );
}
