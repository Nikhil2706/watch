import { PosterCard } from "./PosterCard";
import type { ListKind } from "@/lib/lists";
import type { MediaItem } from "@/lib/media";

/**
 * A horizontally scrolling row of posters.
 *
 * Scrolling is pure CSS (`overflow-x` + `scroll-snap`), which means this stays a
 * server component with no JavaScript shipped, and it behaves natively on a
 * touchscreen — the main way this will be used.
 */
export function Row({
  title,
  items,
  lists,
  itemTitles,
  itemHrefs,
  itemPosters,
  itemPartsCounts,
}: {
  title: string;
  items: MediaItem[];
  /** item id -> lists it is on, so the toggles render in the right state. */
  lists?: Map<string, Set<ListKind>>;
  /** item id -> display title override, e.g. "Episode 7: Title" instead of the item's own (possibly still wrong) Name. */
  itemTitles?: Map<string, string>;
  /** item id -> link override — set for a collapseEpisodeGroups() group tile, pointing at /collection/{groupId}. */
  itemHrefs?: Map<string, string>;
  /** item id -> poster override — the series' own poster, for a group tile. */
  itemPosters?: Map<string, string | null>;
  /** item id -> episode count — renders the "N parts" badge in place of a year, for a group tile. */
  itemPartsCounts?: Map<string, number>;
}) {
  if (items.length === 0) return null;

  return (
    <section className="row" aria-label={title}>
      <h2>{title}</h2>
      <div className="row-scroll">
        {items.map((item) => (
          <PosterCard
            key={item.Id}
            item={item}
            lists={lists?.get(item.Id)}
            title={itemTitles?.get(item.Id)}
            href={itemHrefs?.get(item.Id)}
            posterSrc={itemPosters?.get(item.Id)}
            partsCount={itemPartsCounts?.get(item.Id)}
          />
        ))}
      </div>
    </section>
  );
}
