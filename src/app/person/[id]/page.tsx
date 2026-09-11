import { notFound, redirect } from "next/navigation";

import { ExpandableBio } from "@/components/media/ExpandableBio";
import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { getMemberships } from "@/lib/lists";
import {
  collapseEpisodeGroups,
  getItemsByPerson,
  getPerson,
  getSpecialFeaturesForPerson,
  personPhotoUrl,
} from "@/lib/media";
import { SpecialFeaturesRow } from "@/components/media/SpecialFeaturesRow";
import { MissingFilms } from "@/components/media/MissingFilms";
import { directorGaps } from "@/lib/director-gaps";
import { personFacts } from "@/lib/person-facts";
import { directsHere, ownedMovieTmdbIds, personForPage } from "@/lib/tmdb-person";

export const dynamic = "force-dynamic";

/**
 * Everything in the library featuring one person.
 *
 * Reached by tapping a face in the cast row. Jellyfin does the filtering with
 * `personIds`, so this is a single request regardless of library size.
 */
export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const [person, items, specialFeatures] = await Promise.all([
    getPerson(session, id),
    getItemsByPerson(session, id),
    // A documentary about this person belongs here as much as on each of
    // their films — arguably more, since this is the page somebody opens
    // wanting to know about them rather than about one film.
    getSpecialFeaturesForPerson(session, id).catch(() => []),
  ]);

  if (!person) notFound();

  // A show this person appears in becomes one "N parts" tile, same as
  // everywhere else a browse-titles list is shown — otherwise an actor in a
  // ten-episode season shows up here as ten near-identical entries.
  const collapsed = collapseEpisodeGroups(items);

  // TMDB fills what Jellyfin lacks and never overrides what it has. This
  // page's biography and portrait were chosen deliberately, and TMDB is an
  // addition on top of the existing design rather than a replacement for it.
  // Jellyfin holds TMDB's id for nearly every person, so nothing here is
  // matched by name.
  const tmdbId = Number(person.ProviderIds?.Tmdb);
  const tmdb = Number.isSafeInteger(tmdbId) && tmdbId > 0 ? personForPage(tmdbId) : null;
  const photo = personPhotoUrl(person, 260) ?? tmdb?.profileUrl ?? null;
  const bio = person.Overview || tmdb?.biography || null;
  const facts = personFacts(tmdb);
  // Directors only, by decision: see director-gaps.ts.
  const gaps =
    tmdb && directsHere(tmdb.tmdbId)
      ? directorGaps(tmdb.directed, ownedMovieTmdbIds(), new Date().getUTCFullYear())
      : null;
  const lists = getMemberships(
    session.userId,
    collapsed.items.map((item) => item.Id),
  );

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <SpecialFeaturesRow features={specialFeatures} />

      <section className="person-head">
        <div className="person-photo">
          {photo ? (
            <img src={photo} alt="" decoding="async" />
          ) : (
            <span className="cast-initials">
              {person.Name.split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0] ?? "")
                .join("")
                .toUpperCase()}
            </span>
          )}
        </div>
        <div className="person-text">
          <h1>{person.Name}</h1>
          <p className="person-count">
            {collapsed.items.length === 0
              ? "Nothing else in the library"
              : `${collapsed.items.length} title${collapsed.items.length === 1 ? "" : "s"} here`}
          </p>
          {facts ? <p className="person-facts">{facts}</p> : null}
          {bio ? <ExpandableBio text={bio} /> : null}
        </div>
      </section>

      {collapsed.items.length > 0 ? (
        <div className="grid">
          {collapsed.items.map((item) => (
            <PosterCard
              key={item.Id}
              item={item}
              lists={lists.get(item.Id)}
              href={collapsed.hrefs.get(item.Id)}
              posterSrc={collapsed.posters.get(item.Id)}
              partsCount={collapsed.partsCounts.get(item.Id)}
              partsUnit={collapsed.partsUnits.get(item.Id)}
            />
          ))}
        </div>
      ) : (
        <div className="empty">
          They are credited on a title here, but nothing else matches.
        </div>
      )}

      {gaps ? <MissingFilms gaps={gaps} /> : null}
    </>
  );
}
