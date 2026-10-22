import { redirect } from "next/navigation";

import { ActivityVisibility } from "@/components/ActivityVisibility";
import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { episodeCards } from "@/lib/episode-cards";
import { activityVisibility } from "@/lib/friends";
import { getMemberships } from "@/lib/lists";
import { getRecentlyWatched } from "@/lib/media";
import { groupByMonth, watchedOn } from "@/lib/watch-history";

export const dynamic = "force-dynamic";

/**
 * Everything this viewer has finished, newest first, a section per month.
 * Home's Recently watched row is the top of this list; its heading links here.
 *
 * "Finished" is Jellyfin's played flag: watched to the end, or marked
 * watched. Half-watched titles are in Continue watching instead. A title
 * hidden or removed since drops out, as it does everywhere else.
 */

/** Far more than anyone here has watched; the page says so if it is ever reached. */
const HISTORY_LIMIT = 2000;

export default async function HistoryPage() {
  const session = await currentSession();
  if (!session) redirect("/login");

  const watched = await getRecentlyWatched(session, HISTORY_LIMIT).catch(() => null);
  const months = watched ? groupByMonth(watched) : [];
  const cards = episodeCards(watched ?? []);
  const lists = getMemberships(session.userId, (watched ?? []).map((i) => i.Id));

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />

      <div className="page-head">
        <h1>History</h1>
        {watched && watched.length > 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {watched.length} {watched.length === 1 ? "title" : "titles"} watched to the end
          </p>
        ) : null}
        <ActivityVisibility initial={activityVisibility(session.userId)} />
      </div>

      {watched === null ? (
        <div className="empty">
          <p>The library is not answering right now.</p>
          <p className="hint" style={{ margin: 0 }}>
            Try again in a few minutes.
          </p>
        </div>
      ) : watched.length === 0 ? (
        <div className="empty">
          <p>Nothing watched to the end yet.</p>
          <p className="hint" style={{ margin: 0 }}>
            Films you finish, or mark as watched, are listed here. Ones you are part-way through are in Continue
            watching on Home.
          </p>
        </div>
      ) : null}

      {months.map((month) => (
        <section key={month.label} className="row" aria-label={month.label}>
          <h2>{month.label}</h2>
          <div className="grid">
            {month.items.map((item) => {
              const day = watchedOn(item);
              const line = cards.lines.get(item.Id);
              return (
                <PosterCard
                  key={item.Id}
                  item={item}
                  lists={lists.get(item.Id)}
                  title={cards.titles.get(item.Id)}
                  posterSrc={cards.posters.get(item.Id)}
                  badge={[line, day].filter(Boolean).join(" · ") || undefined}
                  // On here: pressing it marks the title unwatched again.
                  markWatched
                />
              );
            })}
          </div>
        </section>
      ))}

      {watched && watched.length >= HISTORY_LIMIT ? (
        <p className="hint" style={{ textAlign: "center" }}>
          Showing the most recent {HISTORY_LIMIT}.
        </p>
      ) : null}
    </>
  );
}
