"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCloseOnBack } from "@/lib/overlay-back";
import type { PickTile } from "@/lib/pick-views";

/** Long enough not to fire on a scroll that starts on a poster, short enough to feel like a hold. */
const HOLD_MS = 420;
/** Finger travel that turns a hold into a scroll. */
const MOVE_TOLERANCE_PX = 10;

/**
 * The scrolling row of a pick.
 *
 * With a mouse or a TV remote the tile under the pointer or the focus opens by
 * CSS alone (globals.css, .pk-tile): it widens, pushes its neighbours aside
 * and shows more of the writeup. A touchscreen has neither hover nor focus, so
 * pressing and holding a tile lifts it into a card instead — that is the only
 * part of this that needs script.
 *
 * A tap always opens the film. The hold is the "read a little more" step; the
 * full writeup is on the film's own page.
 */
export function PickRail({ tiles, ranked }: { tiles: PickTile[]; ranked: boolean }) {
  const [held, setHeld] = useState<PickTile | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // The click that follows a hold must not also open the film.
  const swallowClick = useRef(false);

  const close = useCallback(() => setHeld(null), []);
  useCloseOnBack(held !== null, close);

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  function onTouchStart(tile: PickTile, event: React.TouchEvent) {
    const touch = event.touches[0];
    if (!touch || event.touches.length > 1) return;
    cancel();
    start.current = { x: touch.clientX, y: touch.clientY };
    timer.current = setTimeout(() => {
      timer.current = null;
      swallowClick.current = true;
      setHeld(tile);
    }, HOLD_MS);
  }

  function onTouchMove(event: React.TouchEvent) {
    const touch = event.touches[0];
    if (!touch || !start.current) return;
    if (
      Math.abs(touch.clientX - start.current.x) > MOVE_TOLERANCE_PX ||
      Math.abs(touch.clientY - start.current.y) > MOVE_TOLERANCE_PX
    ) {
      cancel();
    }
  }

  function onClick(event: React.MouseEvent) {
    if (swallowClick.current) {
      swallowClick.current = false;
      event.preventDefault();
    }
  }

  return (
    <>
      <div className="row-scroll pk-rail">
        {tiles.map((tile) => (
          <Link
            key={tile.key}
            href={tile.href}
            className={tile.shape === "still" ? "pk-tile is-still" : "pk-tile"}
            onTouchStart={(e) => onTouchStart(tile, e)}
            onTouchMove={onTouchMove}
            onTouchEnd={cancel}
            onTouchCancel={cancel}
            onClick={onClick}
            // A long press on a link otherwise opens the browser's own menu.
            onContextMenu={(e) => e.preventDefault()}
            draggable={false}
          >
            <TileFace tile={tile} ranked={ranked} />
          </Link>
        ))}
      </div>

      {held ? (
        <div className="pk-held" role="dialog" aria-label={held.title} onClick={close}>
          <Link
            href={held.href}
            className={held.shape === "still" ? "pk-held-card is-still" : "pk-held-card"}
            onClick={(e) => e.stopPropagation()}>
            <TileFace tile={held} ranked={ranked} />
            <span className="pk-held-open">Open for the full writeup &rarr;</span>
          </Link>
        </div>
      ) : null}
    </>
  );
}

function TileFace({ tile, ranked }: { tile: PickTile; ranked: boolean }) {
  return (
    <span className="pk-card">
      <span className="pk-art">
        {tile.posterSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- same reasoning as PosterCard: Jellyfin already resizes these
          <img src={tile.posterSrc} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="fallback">{tile.title}</span>
        )}
      </span>
      {ranked && tile.rank !== null ? (
        <span className="pk-num" aria-label={`Number ${tile.rank}`}>
          {tile.rank}
        </span>
      ) : null}
      <span className="pk-name">
        {tile.title}
        {tile.sub ? <span className="pk-year"> {tile.sub}</span> : null}
      </span>
      {tile.excerpt ? (
        <span className="pk-text">
          {tile.excerpt}
          {tile.writeupSourceLabel ? <span className="pk-credit"> &mdash; {tile.writeupSourceLabel}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
