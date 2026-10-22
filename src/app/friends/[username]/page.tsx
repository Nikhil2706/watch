import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { currentSession } from "@/lib/current-user";
import { episodeCards } from "@/lib/episode-cards";
import { stars } from "@/lib/friends-feed";
import { DIARY_LIMIT, friendDiary } from "@/lib/friends-diary";
import { posterUrl } from "@/lib/media";
import { itemHref } from "@/lib/slugs";
import { dayOf, groupByMonthOf } from "@/lib/watch-history";

export const dynamic = "force-dynamic";

/**
 * A friend's diary (friends-diary.ts): everything they have finished, newest
 * first, a section per month; each line with the day, whether it was a
 * rewatch, their stars and their review. Only for a friend who shares what
 * they watch; anyone else is a 404, the same as a page that isn't there.
 */
export default async function FriendDiaryPage({ params }: { params: Promise<{ username: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { username } = await params;
  const diary = await friendDiary(session, decodeURIComponent(username)).catch(() => null);
  if (!diary) notFound();

  const cards = episodeCards(diary.entries.map((e) => e.item));
  const months = groupByMonthOf(diary.entries, (e) => e.entry.watchedAt);

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <div className="page-head">
        <h1>{diary.friend.username}&apos;s diary</h1>
        <p className="hint" style={{ margin: 0 }}>
          {diary.entries.length} watched
          {diary.notShown ? ` · ${diary.notShown} more you can't open here` : null} ·{" "}
          <Link href="/friends">All friends ›</Link>
        </p>
      </div>

      {!diary.entries.length ? (
        <div className="empty">
          <p>Nothing here yet.</p>
        </div>
      ) : null}

      {months.map((month) => (
        <section key={month.label} className="diary-month" aria-label={month.label}>
          <h2>{month.label}</h2>
          <ol className="diary-list">
            {month.items.map(({ entry, item }) => {
              const show = cards.titles.get(item.Id);
              const poster = cards.posters.get(item.Id) ?? posterUrl(item, 92);
              return (
                <li key={`${item.Id}:${entry.watchedAt}`} className="diary-entry">
                  <span className="diary-day">{dayOf(entry.watchedAt)}</span>
                  <Link href={itemHref(item.Id, item.Name, item.ProductionYear)} className="diary-poster" aria-hidden="true" tabIndex={-1}>
                    {poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={poster} alt="" loading="lazy" />
                    ) : null}
                  </Link>
                  <div className="diary-body">
                    <Link href={itemHref(item.Id, item.Name, item.ProductionYear)} className="diary-title">
                      {show ?? item.Name}
                      {!show && item.ProductionYear ? <span className="diary-year"> {item.ProductionYear}</span> : null}
                    </Link>
                    {cards.lines.get(item.Id) ? <span className="hint"> · {cards.lines.get(item.Id)}</span> : null}
                    <div className="diary-meta">
                      {entry.score !== null ? <span className="diary-stars">{stars(entry.score)}</span> : null}
                      {entry.rewatch ? (
                        <span className="diary-rewatch" title="A rewatch">
                          ↻ rewatch
                        </span>
                      ) : null}
                    </div>
                    {entry.review ? <p className="diary-review">{entry.review}</p> : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}

      {diary.truncated ? (
        <p className="hint" style={{ textAlign: "center" }}>
          Showing the most recent {DIARY_LIMIT}.
        </p>
      ) : null}
    </>
  );
}
