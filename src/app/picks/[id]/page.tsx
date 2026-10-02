import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { Writeup } from "@/components/picks/Writeup";
import { CURATOR_NAME } from "@/lib/curator-name";
import { currentSession } from "@/lib/current-user";
import { pickForViewer } from "@/lib/pick-views";

export const dynamic = "force-dynamic";

/**
 * One pick, read top to bottom: every title in order with its writeup in full.
 * The rows on the Picks page and Home show a few lines of each; this is where
 * the whole thing is.
 *
 * A pick made for other people is a 404 here, the same as one that does not
 * exist — its URL must not confirm that it does.
 */
export default async function PickPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const pick = await pickForViewer(session, id);
  if (!pick) notFound();

  const count = pick.tiles.length;

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <div className="page-head pk-page-head">
        <Link className="pk-back" href="/picks">
          &larr; Picks
        </Link>
        {pick.personal ? <span className="pk-for-you">Picked for you by {CURATOR_NAME}</span> : null}
        <h1>{pick.title}</h1>
        {pick.subtitle ? <p className="page-sub">{pick.subtitle}</p> : null}
        <p className="pk-source">
          {count} {count === 1 ? "title" : "titles"}
          {pick.ranked ? " · ranked" : ""}
          {pick.publishedAt
            ? ` · ${new Date(pick.publishedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
            : ""}
        </p>
        {pick.sourceLabel ? (
          <p className="pk-source">
            From{" "}
            {pick.sourceUrl ? (
              <a href={pick.sourceUrl} target="_blank" rel="noopener noreferrer">
                {pick.sourceLabel}
              </a>
            ) : (
              pick.sourceLabel
            )}{" "}
            &middot; {count} of {pick.totalItems} in the library
          </p>
        ) : null}
      </div>

      {count === 0 ? (
        <div className="empty">
          <p>Nothing from this pick is in the library right now.</p>
        </div>
      ) : (
        <ol className={pick.ranked ? "pk-list is-ranked" : "pk-list"}>
          {pick.tiles.map((tile, index) => (
            <li key={tile.key} className="pk-entry-row">
              {pick.ranked && tile.rank !== null ? (
                <span className="pk-list-num" aria-label={`Number ${tile.rank}`}>
                  {tile.rank}
                </span>
              ) : null}
              <Link
                className="pk-list-art"
                href={tile.href}
                // The TV lands on the first title, not on the back link.
                data-tv-autofocus={index === 0 ? "true" : undefined}
                aria-label={tile.title}
              >
                {tile.posterSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element -- same reasoning as PosterCard
                  <img src={tile.posterSrc} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="fallback">{tile.title}</span>
                )}
              </Link>
              <div className="pk-list-body">
                <h2>
                  <Link href={tile.href}>{tile.title}</Link>
                  {tile.sub ? <span className="pk-year"> {tile.sub}</span> : null}
                </h2>
                <Writeup
                  text={tile.writeup}
                  sourceLabel={tile.writeupSourceLabel}
                  sourceUrl={tile.writeupSourceUrl}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
