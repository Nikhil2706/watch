import { PosterCard } from "./PosterCard";
import type { ListKind } from "@/lib/lists";
import { prefersStillLayout, type MediaItem } from "@/lib/media";

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
  itemPartsUnits,
  itemBadges,
  shape,
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
  /** item id -> episode count — renders the "N parts" / "N episodes" badge in place of a year, for a group tile. */
  itemPartsCounts?: Map<string, number>;
  /** item id -> wording for that count. Absent means "parts". */
  itemPartsUnits?: Map<string, "parts" | "episodes">;
  /** item id -> a short label on the card, e.g. naming which source picked it. */
  itemBadges?: Map<string, string>;
  /**
   * Card geometry for the whole row. Left unset, the row measures its own
   * artwork and lays out episode stills landscape — see prefersStillLayout().
   * Pass it explicitly only to override that, e.g. a row of group tiles which
   * carry a series poster rather than each item's own art.
   */
  shape?: "poster" | "still";
}) {
  if (items.length === 0) return null;

  const rowShape = shape ?? (prefersStillLayout(items) ? "still" : "poster");

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
            partsUnit={itemPartsUnits?.get(item.Id)}
            badge={itemBadges?.get(item.Id)}
            shape={rowShape}
          />
        ))}
      </div>
    </section>
  );
}
