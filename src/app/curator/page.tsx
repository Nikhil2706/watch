import Link from "next/link";
import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { CuratorPicks } from "@/components/media/CuratorPicks";
import { currentSession } from "@/lib/current-user";
import { listCurations } from "@/lib/curations";
import { getItem, getItemsByImdbIds } from "@/lib/media";
import { listPicksForUser } from "@/lib/notifications";
import { itemHref } from "@/lib/slugs";

export const dynamic = "force-dynamic";

/**
 * The curator's reading list.
 *
 * Picks attached to a film also appear on that film's page, but a pick with no
 * film attached previously had nowhere to live at all — it was written, stored,
 * and invisible. This is that home, and it doubles as the one place to see
 * everything the curator has written in one go.
 */
export default async function CuratorPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const all = listCurations(100);

  /*
   * Films the curator sent to THIS person, newest first, above the reading.
   * They arrive as notifications, which until now meant a pick lived only in
   * the bell — read once and gone. This is the page that page-title promises,
   * so it belongs at the top of it.
   *
   * Posters come from one batched Jellyfin lookup by IMDb id rather than
   * parsing the stored href, and a title no longer in the library simply
   * renders without art instead of vanishing.
   */
  const picks = listPicksForUser(session.userId);
  const pickItems = await getItemsByImdbIds(
    session,
    picks.map((p) => p.imdbId),
  ).catch(() => new Map());

  // Split so a reader can tell "further reading on a film we have" from
  // "something worth reading in its own right".
  const standalone = all.filter((pick) => !pick.jellyfin_item_id);
  const attached = all.filter((pick) => pick.jellyfin_item_id);

  // Resolve titles so an attached pick can say what it is about.
  const titles = new Map<string, string>();
  await Promise.all(
    [...new Set(attached.map((p) => p.jellyfin_item_id!))].map(async (id) => {
      const item = await getItem(session, id).catch(() => null);
      if (item) titles.set(id, item.Name);
    }),
  );

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <div className="page-head">
        <h1>Curator&rsquo;s Picks</h1>
        <p className="page-sub">
          Articles, essays and notes worth your time — chosen by the person who
          runs this library.
        </p>
      </div>

      {all.length === 0 && picks.length === 0 ? (
        <div className="empty">
          <p>Nothing here yet.</p>
          <p className="hint" style={{ margin: 0 }}>
            Picks are added with the admin API and show up here, plus on the film
            they refer to.
          </p>
        </div>
      ) : null}

      {picks.length > 0 ? (
        <section className="row curator" aria-label="Picked for you">
          <h2>Picked for you</h2>
          <div className="curator-grid">
            {picks.map((pick) => {
              const item = pickItems.get(pick.imdbId);
              return (
                <div key={pick.imdbId} className="curator-card">
                  <div className="curator-kind">
                    {new Date(pick.sentAt).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "long",
                      year: "numeric",
                    })}
                  </div>
                  <div className="curator-title">{item?.Name ?? pick.filmTitle}</div>
                  {pick.note ? <blockquote className="curator-comment">{pick.note}</blockquote> : null}
                  <div className="curator-links">
                    <Link href={pick.filmHref}>Watch it &rarr;</Link>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <CuratorPicks picks={standalone} heading="Reading" />

      {attached.length > 0 ? (
        <section className="row curator" aria-label="On films in the library">
          <h2>On films here</h2>
          <div className="curator-grid">
            {attached.map((pick) => (
              <div key={pick.id} className="curator-card">
                <div className="curator-kind">{pick.kind}</div>
                <div className="curator-title">{pick.title}</div>
                {pick.comment ? (
                  <blockquote className="curator-comment">{pick.comment}</blockquote>
                ) : null}
                <div className="curator-by">&mdash; {pick.curator}</div>
                <div className="curator-links">
                  <Link href={itemHref(pick.jellyfin_item_id!, titles.get(pick.jellyfin_item_id!))}>
                    {titles.get(pick.jellyfin_item_id!) ?? "View the film"} &rarr;
                  </Link>
                  {pick.url ? (
                    <a href={pick.url} target="_blank" rel="noopener noreferrer">
                      Read &rarr;
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
