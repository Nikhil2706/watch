import Link from "next/link";

import { episodeCards } from "@/lib/episode-cards";
import { stars } from "@/lib/friends-feed";
import type { UserDiary } from "@/lib/friends-diary";
import { posterUrl } from "@/lib/media";
import { itemHref } from "@/lib/slugs";
import { dayOf, groupByMonthOf } from "@/lib/watch-history";

/**
 * A diary, Letterboxd-style (diary.ts): a section per month, and a line per
 * finish with the day, the poster, the title, the stars given, whether it was
 * a rewatch, and the review written. A friend's (/friends/[username]) and the
 * viewer's own (History, Diary view) are drawn the same way.
 */
export function DiaryList({ entries }: { entries: UserDiary["entries"] }) {
  const cards = episodeCards(entries.map((e) => e.item));
  const months = groupByMonthOf(entries, (e) => e.entry.watchedAt);
  return (
    <>
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
    </>
  );
}
