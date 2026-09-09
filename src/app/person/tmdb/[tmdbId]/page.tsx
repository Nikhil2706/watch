import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { getMemberships } from "@/lib/lists";
import { collapseEpisodeGroups, getItemsByPaths, type MediaItem } from "@/lib/media";
import { creditsForPerson, personById } from "@/lib/tmdb-people";
import { initialsOf } from "@/lib/credit-cards";

export const dynamic = "force-dynamic";

/** How a stored department reads as a section heading on this page. */
const DEPARTMENT_HEADINGS: Record<string, string> = {
  cast: "Acted in",
  directors: "Directed",
  writers: "Wrote",
  cinematographers: "Shot",
  editors: "Edited",
  composers: "Scored",
  productionDesigners: "Designed",
};

/**
 * Everything in the library one TMDB person worked on.
 *
 * A sibling of /person/{jellyfinId} rather than a replacement for it. That page
 * asks Jellyfin to filter by personId, which works beautifully for actors and
 * not at all for anyone else: Jellyfin holds no cinematographers, editors,
 * composers or production designers, so those people have no Jellyfin id to be
 * filtered by. This page answers the same question from tmdb_credits instead.
 *
 * The two will co-exist indefinitely. Where Jellyfin knows someone, its own
 * page is the better one — it has their portrait and their biography — so a
 * card only links here when there is no Jellyfin id to link to.
 */
export default async function TmdbPersonPage({
  params,
}: {
  params: Promise<{ tmdbId: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { tmdbId } = await params;
  const id = Number.parseInt(tmdbId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();

  const person = personById(id);
  if (!person) notFound();

  const credits = creditsForPerson(id);
  if (credits.length === 0) notFound();

  // Credits are keyed on path for a film and on group id for a show. Only the
  // film half resolves to a playable item here; a group already has its own
  // page, so it is listed as a link rather than fetched as an item.
  const paths = credits.filter((c) => c.subjectType === "path").map((c) => c.subjectId);
  const items: MediaItem[] = paths.length
    ? Array.from((await getItemsByPaths(session, paths)).values())
    : [];

  // Same collapse every other list uses, so an actor in a ten-episode season
  // is one tile rather than ten near-identical ones.
  const collapsed = collapseEpisodeGroups(items);
  const lists = getMemberships(
    session.userId,
    collapsed.items.map((i) => i.Id),
  );

  // Split by department rather than one flat grid. Someone who shot four films
  // here and directed one is not doing the same job twice, and a single run of
  // posters cannot say which is which.
  const byPath = new Map(collapsed.items.map((i) => [i.Path ?? "", i]));
  const sections = new Map<string, MediaItem[]>();
  for (const c of credits) {
    if (c.subjectType !== "path") continue;
    const found = byPath.get(c.subjectId);
    if (!found) continue;
    const label = DEPARTMENT_HEADINGS[c.department] ?? "Other";
    const bucket = sections.get(label);
    if (bucket) {
      if (!bucket.some((i) => i.Id === found.Id)) bucket.push(found);
    } else {
      sections.set(label, [found]);
    }
  }
  const ordered = [...sections.entries()].sort((a, b) => b[1].length - a[1].length);

  // What they are known for here, most-credited job first — a person who edited
  // nine films and shot one should read as an editor.
  const jobCounts = new Map<string, number>();
  for (const c of credits) jobCounts.set(c.job, (jobCounts.get(c.job) ?? 0) + 1);
  const jobs = [...jobCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([job]) => job)
    .slice(0, 4);

  const photo = person.profilePath ? `/api/person-photo/${person.tmdbId}?size=h632` : null;

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <section className="person-head">
        <div className="person-photo">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" decoding="async" />
          ) : (
            <span className="cast-initials">{initialsOf(person.name)}</span>
          )}
        </div>
        <div>
          <h1>{person.name}</h1>
          {jobs.length > 0 ? <p className="page-sub">{jobs.join(" · ")}</p> : null}
          <p className="page-sub">
            {credits.length} credit{credits.length === 1 ? "" : "s"} in this library
          </p>
        </div>
      </section>

      {ordered.length > 0 ? (
        ordered.map(([heading, filmsForDept]) => (
          <section key={heading} className="row" aria-label={heading}>
            <h2>
              {heading}
              <span className="row-count"> {filmsForDept.length}</span>
            </h2>
            <div className="grid">
              {filmsForDept.map((mediaItem) => (
                <PosterCard
                  key={mediaItem.Id}
                  item={mediaItem}
                  lists={lists.get(mediaItem.Id)}
                  href={collapsed.hrefs.get(mediaItem.Id)}
                  posterSrc={collapsed.posters.get(mediaItem.Id)}
                  partsCount={collapsed.partsCounts.get(mediaItem.Id)}
                  partsUnit={collapsed.partsUnits.get(mediaItem.Id)}
                />
              ))}
            </div>
          </section>
        ))
      ) : (
        <p className="page-sub" style={{ padding: "0 20px" }}>
          Their credits here are all on titles that are no longer in the library.
        </p>
      )}
    </>
  );
}
