"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useTvMode } from "@/components/tv/TvProvider";
import { itemHref } from "@/lib/slugs";

interface Hit {
  id: string;
  name: string;
  year: number | null;
  poster: string | null;
  reason: string;
  href?: string;
  partsCount?: number;
}

/**
 * Type-ahead search.
 *
 * Debounced at 250 ms: each keystroke otherwise fires a request that also scans
 * the catalogue server-side, and the results of all but the last are thrown
 * away. An AbortController cancels the in-flight request so a slow early query
 * cannot land after a faster later one and overwrite it.
 *
 * Still a real <form> underneath, so pressing Enter goes to the full results
 * page and the whole thing degrades to a plain GET without JavaScript.
 */
export function SearchBox({ initialQuery = "" }: { initialQuery?: string }) {
  const tvMode = useTvMode();
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits([]);
      setLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/search/suggest?q=${encodeURIComponent(query.trim())}`,
          { signal: controller.signal },
        );
        if (!response.ok) return;
        const data = (await response.json()) as { results?: Hit[] };
        setHits(data.results ?? []);
        setOpen(true);
      } catch {
        /* aborted or offline — leave the previous results alone */
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [query]);

  // Close when focus or a click goes elsewhere.
  useEffect(() => {
    function onDocClick(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Typing into a small header field with a D-pad is exactly the "tiny HTML
  // input" experience the brief calls out — the dedicated /search page
  // already has a large, remote-friendly field and its own on-screen
  // keyboard fallback (see search/page.tsx), so TV mode just links there
  // instead of trying to shrink the type-ahead UI down to fit a remote.
  if (tvMode) {
    return (
      <Link href="/search" className="tv-search-link" aria-label="Search">
        🔍 Search
      </Link>
    );
  }

  return (
    <div className="searchbox" ref={boxRef}>
      <form action="/search" method="get" role="search">
        <input
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          onKeyDown={(event) => {
            // Consumed here so it closes the dropdown instead of also
            // reaching TvProvider's global Escape/Back handler, which would
            // otherwise navigate away instead of just dismissing this.
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder="Search titles, cast, genre…"
          aria-label="Search"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </form>

      {open && (hits.length > 0 || loading) ? (
        <div className="suggest" role="listbox">
          {loading && hits.length === 0 ? (
            <div className="suggest-empty">Searching…</div>
          ) : null}
          {hits.map((hit) => (
            <a key={hit.id} className="suggest-row" href={hit.href ?? itemHref(hit.id, hit.name, hit.year)} role="option">
              {hit.poster ? (
                <img src={hit.poster} alt="" loading="lazy" />
              ) : (
                <div className="suggest-noart" />
              )}
              <div className="suggest-text">
                <div className="suggest-title">
                  {hit.name}
                  {hit.year ? <span className="suggest-year"> {hit.year}</span> : null}
                </div>
                <div className="suggest-reason">
                  {hit.partsCount ? `${hit.partsCount} parts` : hit.reason}
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}
