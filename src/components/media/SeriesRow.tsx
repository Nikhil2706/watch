import Link from "next/link";

import type { ListKind } from "@/lib/lists";
import type { MediaItem } from "@/lib/media";
import { posterUrl } from "@/lib/media";
import type { SeriesEntry } from "@/lib/scraping/film-series";

import { PosterCard } from "./PosterCard";

/**
 * "In this series" — every film Wikipedia's own film-series lists carry for
 * this franchise, in release order, not just the ones you own. An entry not
 * in the library still shows (title, year, a plain placeholder tile) so the
 * row reads as "here's the whole series," matching how streaming apps
 * usually present a franchise rather than silently hiding gaps.
 *
 * Deliberately not built on the shared Row component: Row assumes every
 * item is a real MediaItem it can hand straight to PosterCard, and this row
 * has to render out-of-library entries too, which have no MediaItem at all.
 */
export function SeriesRow({
  title,
  entries,
  items,
  lists,
  currentImdbId,
}: {
  title: string;
  entries: SeriesEntry[];
  /** imdb_id -> the resolved Jellyfin item, for every entry that's actually owned. */
  items: Map<string, MediaItem>;
  lists?: Map<string, Set<ListKind>>;
  /** Highlights which tile is "this film" — the visitor is already on its page. */
  currentImdbId?: string;
}) {
  if (entries.length === 0) return null;

  return (
    <section className="row" aria-label={title}>
      <h2>{title}</h2>
      <div className="row-scroll">
        {entries.map((entry) => {
          const owned = entry.imdb_id ? items.get(entry.imdb_id) : undefined;
          const isCurrent = entry.imdb_id !== null && entry.imdb_id === currentImdbId;

          if (owned) {
            return (
              <PosterCard
                key={entry.position}
                item={owned}
                lists={lists?.get(owned.Id)}
                badge={isCurrent ? "Watching now" : undefined}
              />
            );
          }

          return (
            <div key={entry.position} className="poster series-poster-placeholder">
              <div className="poster-art">
                <div className="fallback">{entry.raw_title}</div>
              </div>
              <div className="poster-title">{entry.raw_title}</div>
              {entry.raw_year ? <div className="poster-sub">{entry.raw_year} · not in your library</div> : (
                <div className="poster-sub">Not in your library</div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

void Link;
void posterUrl;
