"use client";

import { useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";

export interface SearchResult {
  imdbId: string;
  name: string;
  year: number | null;
}

/**
 * Search-as-you-type over the library (the accolades search). Used to link a
 * scraped mention to a film and to fill a builder row; `episodes` lets a row
 * hold one episode of a show as well as a film.
 */
export function LibrarySearch({
  placeholder,
  onPick,
  episodes,
  value,
  onType,
  emptyNote = "No matches.",
}: {
  placeholder: string;
  onPick: (r: SearchResult) => void;
  episodes?: boolean;
  value?: string;
  onType?: (v: string) => void;
  emptyNote?: string;
}) {
  const [own, setOwn] = useState("");
  const q = value ?? own;
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const typed = useRef(false);

  useEffect(() => {
    if (!typed.current) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const d = await adminApi<{ results: SearchResult[] }>(`/api/admin/accolades/search?${episodes ? "episodes=1&" : ""}q=${encodeURIComponent(query)}`);
        setResults(d.results ?? []);
      } catch {
        setResults(null);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, episodes]);

  return (
    <div className="adm-ac-search">
      <input
        value={q}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          typed.current = true;
          (onType ?? setOwn)(e.target.value);
        }}
      />
      {results ? (
        <div className="adm-ac-results">
          {results.length ? (
            results.map((r) => (
              <button
                key={r.imdbId}
                type="button"
                className="adm-ac-result"
                onClick={() => {
                  typed.current = false;
                  setResults(null);
                  onPick(r);
                }}
              >
                {r.name} <span className="hint">{r.year ?? ""}</span>
              </button>
            ))
          ) : (
            <div className="hint">{emptyNote}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
