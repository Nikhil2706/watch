import Link from "next/link";

import type { ListKind } from "@/lib/lists";
import {
  formatRuntime,
  posterUrl,
  progressPercent,
  type MediaItem,
} from "@/lib/media";

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
  badge,
  href,
  posterSrc,
  partsCount,
  title,
}: {
  item: MediaItem;
  /** Which lists this item is already on, for the toggle initial state. */
  lists?: Set<ListKind>;
  /** Optional caption, e.g. why a search matched. */
  badge?: string;
  /** Overrides the default /item/{id} link — used for Collection tiles. */
  href?: string;
  /** Overrides the computed poster URL — used when a Collection has no image of its own. */
  posterSrc?: string | null;
  /** When set, this card represents a group of films rather than one — shown as "N parts". */
  partsCount?: number;
  /** Overrides the displayed title — used for episode labels ("Episode 7: ..."), without touching item.Name. */
  title?: string;
}) {
  const src = posterSrc !== undefined ? posterSrc : posterUrl(item);
  const progress = progressPercent(item);
  const watched = item.UserData?.Played === true;
  const runtime = formatRuntime(item.RunTimeTicks);

  return (
    <div className="poster">
      <Link href={href ?? `/item/${item.Id}`} className="poster-link">
        <div className="poster-art">
          {src ? (
            <img src={src} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="fallback">{title ?? item.Name}</div>
          )}

          {/* "Have I seen this?" is the question a shared library gets asked
              most, and Jellyfin already knows the answer. */}
          {watched ? (
            <span className="watched-badge" title="You have watched this">
              ✓
            </span>
          ) : null}

          {runtime ? <span className="runtime-badge">{runtime}</span> : null}

          {/* A Collection tile isn't a playable item — favouriting/rewatch-marking
              it wouldn't mean anything Jellyfin can act on. */}
          {partsCount === undefined ? (
            <ListButtons
              itemId={item.Id}
              initialFavourite={lists?.has("favourite") ?? false}
              initialRewatch={lists?.has("rewatch") ?? false}
            />
          ) : null}

          {progress > 0 && !watched ? (
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

        <div className="poster-title">{title ?? item.Name}</div>
        {partsCount !== undefined ? (
          <div className="poster-badge">{partsCount} parts</div>
        ) : badge ? (
          <div className="poster-badge">{badge}</div>
        ) : item.ProductionYear ? (
          <div className="poster-sub">{item.ProductionYear}</div>
        ) : null}
      </Link>
    </div>
  );
}
