import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { getList, getMemberships } from "@/lib/lists";
import { getItem, type MediaItem } from "@/lib/media";

export const dynamic = "force-dynamic";

/**
 * Favourites and rewatch, side by side.
 *
 * The lists store item ids only, so each is resolved against Jellyfin here. An
 * id that no longer resolves — because the file was removed or the library was
 * rebuilt — is dropped from the display rather than rendered as a broken card.
 */
async function resolve(
  session: NonNullable<Awaited<ReturnType<typeof currentSession>>>,
  ids: string[],
): Promise<MediaItem[]> {
  const items = await Promise.all(ids.map((id) => getItem(session, id).catch(() => null)));
  return items.filter((item): item is MediaItem => item !== null);
}

export default async function WatchlistPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const [favouriteIds, rewatchIds] = [
    getList(session.userId, "favourite"),
    getList(session.userId, "rewatch"),
  ];

  const [favourites, rewatch] = await Promise.all([
    resolve(session, favouriteIds),
    resolve(session, rewatchIds),
  ]);

  const lists = getMemberships(session.userId, [
    ...new Set([...favouriteIds, ...rewatchIds]),
  ]);

  const empty = favourites.length === 0 && rewatch.length === 0;

  return (
    <>
      <AppBar username={session.username} />

      <div style={{ padding: "18px 20px 0" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>My list</h1>
      </div>

      {empty ? (
        <div className="empty">
          <p>Nothing saved yet.</p>
          <p className="hint" style={{ margin: 0 }}>
            Use ☆ on any poster to add a favourite, or ↻ to mark something for a
            rewatch.
          </p>
        </div>
      ) : null}

      {favourites.length > 0 ? (
        <section className="row" aria-label="Favourites">
          <h2>★ Favourites</h2>
          <div className="grid">
            {favourites.map((item) => (
              <PosterCard key={item.Id} item={item} lists={lists.get(item.Id)} />
            ))}
          </div>
        </section>
      ) : null}

      {rewatch.length > 0 ? (
        <section className="row" aria-label="Rewatch">
          <h2>↻ Rewatch</h2>
          <div className="grid">
            {rewatch.map((item) => (
              <PosterCard key={item.Id} item={item} lists={lists.get(item.Id)} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
