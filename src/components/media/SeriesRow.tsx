import Link from "next/link";

import type { ListKind } from "@/lib/lists";
import type { MediaItem } from "@/lib/media";
import { posterUrl } from "@/lib/media";
import type { SeriesEntry } from "@/lib/scraping/film-series";

import { PosterCard } from "./PosterCard";

/**
 * "In this series" — the films from Wikipedia's own film-series lists for
 * this franchise that you actually own, in release order. Entries not in
 * the library are dropped rather than shown as placeholders.
 *
 * Deliberately not built on the shared Row component: Row's item prop type
 * doesn't carry SeriesEntry's position/currentImdbId concerns, and keeping
 * this row separate keeps that mapping local to one place.
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
  const owned = entries
    .map((entry) => ({ entry, item: entry.imdb_id ? items.get(entry.imdb_id) : undefined }))
    .filter((x): x is { entry: SeriesEntry; item: MediaItem } => x.item !== undefined);

  if (owned.length === 0) return null;

  return (
    <section className="row" aria-label={title}>
      <h2>{title}</h2>
      <div className="row-scroll">
        {owned.map(({ entry, item }) => {
          const isCurrent = entry.imdb_id !== null && entry.imdb_id === currentImdbId;
          return (
            <PosterCard
              key={entry.position}
              item={item}
              lists={lists?.get(item.Id)}
              badge={isCurrent ? "Watching now" : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

void Link;
void posterUrl;
