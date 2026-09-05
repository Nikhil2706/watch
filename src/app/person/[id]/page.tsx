import { notFound, redirect } from "next/navigation";

import { ExpandableBio } from "@/components/media/ExpandableBio";
import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { getMemberships } from "@/lib/lists";
import { collapseEpisodeGroups, getItemsByPerson, getPerson, personPhotoUrl } from "@/lib/media";

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
  const [person, items] = await Promise.all([
    getPerson(session, id),
    getItemsByPerson(session, id),
  ]);

  if (!person) notFound();

  // A show this person appears in becomes one "N parts" tile, same as
  // everywhere else a browse-titles list is shown — otherwise an actor in a
  // ten-episode season shows up here as ten near-identical entries.
  const collapsed = collapseEpisodeGroups(items);

  const photo = personPhotoUrl(person, 260);
  const lists = getMemberships(
    session.userId,
    collapsed.items.map((item) => item.Id),
  );

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

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
          {person.Overview ? <ExpandableBio text={person.Overview} /> : null}
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
    </>
  );
}
