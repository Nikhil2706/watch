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
}: {
  title: string;
  items: MediaItem[];
  /** item id -> lists it is on, so the toggles render in the right state. */
  lists?: Map<string, Set<ListKind>>;
}) {
  if (items.length === 0) return null;

  return (
    <section className="row" aria-label={title}>
      <h2>{title}</h2>
      <div className="row-scroll">
        {items.map((item) => (
          <PosterCard key={item.Id} item={item} lists={lists?.get(item.Id)} />
        ))}
      </div>
    </section>
  );
}
