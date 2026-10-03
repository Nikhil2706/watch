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

  // With a mouse there is no way to move along a row that runs off the
  // screen: no scrollbar is drawn, and a wheel only scrolls the page. So the
  // row gets an arrow at whichever end has more to show. A phone swipes and a
  // TV's focus scrolls the row itself, and neither is shown these (globals.css).
  const rail = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  useEffect(() => {
    const el = rail.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      setMore((was) => {
        const next = { left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 };
        return was.left === next.left && was.right === next.right ? was : next;
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // A tile widening under the pointer changes how much there is to scroll.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [tiles.length]);

  function page(direction: 1 | -1) {
    const el = rail.current;
    if (!el) return;
    // Most of a screenful, so the last tile seen is still in view after.
    el.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: "smooth" });
  }

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
      <div className="pk-rail-wrap">
      {/* Not Tab stops: the tiles are, and tabbing to one scrolls it into view. */}
      {more.left ? (
        <button type="button" className="pk-arrow pk-arrow-left" tabIndex={-1} aria-label="Earlier in this pick" onClick={() => page(-1)}>
          &#8249;
        </button>
      ) : null}
      {more.right ? (
        <button type="button" className="pk-arrow pk-arrow-right" tabIndex={-1} aria-label="More of this pick" onClick={() => page(1)}>
          &#8250;
        </button>
      ) : null}
      <div className="row-scroll pk-rail" ref={rail}>
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
      ) : tile.label ? (
        <span className="pk-word">{tile.label}</span>
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
