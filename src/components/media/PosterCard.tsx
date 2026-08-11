import Link from "next/link";

import type { ListKind } from "@/lib/lists";
import { posterUrl, progressPercent, type MediaItem } from "@/lib/media";

import { ListButtons } from "./ListButtons";

/**
 * One poster. Server component — the artwork URL points at /jf/*, so the
 * browser fetches it through the proxy using its session cookie.
 *
 * Plain <img> rather than next/image: the images are already resized by
 * Jellyfin (fillWidth/fillHeight), and routing them through Next's optimiser
 * would re-decode and re-encode every poster on a CPU-constrained host for no
 * benefit.
 */
export function PosterCard({
  item,
  lists,
}: {
  item: MediaItem;
  /** Which lists this item is already on, for the toggle initial state. */
  lists?: Set<ListKind>;
}) {
  const src = posterUrl(item);
  const progress = progressPercent(item);

  return (
    <div className="poster">
      <Link href={`/item/${item.Id}`} className="poster-link">
        <div className="poster-art">
          {src ? (
            <img src={src} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="fallback">{item.Name}</div>
          )}
          {progress > 0 ? (
            <div
              className="progress"
              role="progressbar"
              aria-valuenow={Math.round(progress)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${Math.round(progress)}% watched`}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          ) : null}
        </div>
        <div className="poster-title">{item.Name}</div>
        {item.ProductionYear ? (
          <div className="poster-sub">{item.ProductionYear}</div>
        ) : null}
      </Link>

      <ListButtons
        itemId={item.Id}
        initialFavourite={lists?.has("favourite") ?? false}
        initialRewatch={lists?.has("rewatch") ?? false}
      />
    </div>
  );
}
