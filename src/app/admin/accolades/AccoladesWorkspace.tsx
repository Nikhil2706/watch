"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { accChips, RAIL_CAP, railLine, surprisePick, visibleFilms, type AccFilm, type AccFilter } from "@/lib/admin/accolades-view";

import { Thumb } from "../library/Thumb";
import { useToasts } from "../Toasts";
import { Articles } from "./Articles";
import { Builder } from "./Builder";
import { FilmPane } from "./FilmPane";
import { Sources } from "./Sources";

/**
 * Accolades: the writing scraped about each film, and what of it shows on
 * the film's page — the blurb under the poster, an accolade, trivia. A rail
 * to find a film, a pane to choose; chips carry the counts. Ported from
 * curator.html's Accolades tab.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const VIEWS = [
  ["films", "Films"],
  ["articles", "Articles"],
  ["sources", "Sources"],
] as const;

type View = (typeof VIEWS)[number][0];

export function AccoladesWorkspace() {
  const { show } = useToasts();
  const [view, setView] = useState<View>("films");
  const [films, setFilms] = useState<AccFilm[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AccFilter>("material");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"material" | "name">("material");
  const [selected, setSelected] = useState<{ imdbId: string; name: string } | null>(null);

  const loadFilms = useCallback(async () => {
    try {
      setFilms((await adminApi<{ films: AccFilm[] }>("/api/admin/accolades/films")).films ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(message(e));
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void loadFilms();
  }, [loadFilms]);

  const visible = useMemo(() => (films ? visibleFilms(films, filter, query, sort) : []), [films, filter, query, sort]);
  const chips = useMemo(() => accChips(films ?? [], filter), [films, filter]);
  const shown = visible.slice(0, RAIL_CAP);

  const surprise = () => {
    const pick = surprisePick(films ?? []);
    if (!pick) return show("ok", "Nothing with material waiting — everything with something to read has been dealt with.");
    setFilter("material");
    setQuery("");
    setSelected({ imdbId: pick.imdbId, name: pick.name });
    requestAnimationFrame(() => document.querySelector(`[data-acc-film="${pick.imdbId}"]`)?.scrollIntoView({ block: "center" }));
  };

  return (
    <section className="adm-ac">
      <div className="adm-subtabs" role="tablist" aria-label="Accolades views">
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} className={`adm-subtab${view === key ? " on" : ""}`} onClick={() => setView(key)}>
            {label}
          </button>
        ))}
        {selected && view !== "films" ? <span className="hint adm-ac-for">Passages go to {selected.name}</span> : null}
      </div>

      {view === "films" ? (
        <>
          <div className="adm-chips" role="toolbar" aria-label="Filter">
            {chips.map((c) => (
              <button key={c.key} type="button" className={`adm-chip${c.on ? " on" : ""}`} disabled={!c.count} onClick={() => setFilter(c.key)}>
                {c.label} <b>{c.count}</b>
              </button>
            ))}
          </div>
          <div className="adm-tools">
            <input className="adm-grow" value={query} placeholder="Search a film…" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
              <option value="material">Most material first</option>
              <option value="name">Title A–Z</option>
            </select>
            <button type="button" className="secondary" title="Open a film with good material, chosen at random" onClick={surprise}>
              Surprise me
            </button>
          </div>
          <div className={`adm-split${selected ? " detail-open" : ""}`}>
            <button type="button" className="secondary adm-back" onClick={() => setSelected(null)}>
              ← Back to the list
            </button>
            <div className="adm-rail" role="list">
              {!films ? (
                <div className="empty adm-rail-empty">{loadError ?? "Loading…"}</div>
              ) : !shown.length ? (
                <div className="empty adm-rail-empty">Nothing here.</div>
              ) : (
                shown.map((f) => {
                  const line = railLine(f);
                  return (
                    <div key={f.imdbId} role="listitem" data-acc-film={f.imdbId} className={`adm-rail-item${selected?.imdbId === f.imdbId ? " sel" : ""}`}>
                      <button type="button" className="adm-rail-open" onClick={() => setSelected({ imdbId: f.imdbId, name: f.name })}>
                        <span className={`adm-dot ${line.dot}`} />
                        <Thumb url={f.posterUrl} className="adm-thumb" />
                        <span className="adm-rail-name">
                          <span className="adm-rail-title">{f.name}</span>
                          {line.sub ? <span className="adm-rail-sub">{line.sub}</span> : null}
                        </span>
                      </button>
                    </div>
                  );
                })
              )}
              {visible.length > shown.length ? <div className="empty adm-rail-empty">{visible.length - shown.length} more — narrow it with the search box.</div> : null}
            </div>
            <div className="adm-pane">
              {selected ? <FilmPane key={selected.imdbId} imdbId={selected.imdbId} name={selected.name} onChanged={() => void loadFilms()} /> : <div className="adm-pane-empty">Pick a film on the left.</div>}
            </div>
          </div>
          <Builder onChanged={() => void loadFilms()} />
        </>
      ) : view === "articles" ? (
        <Articles film={selected} onSaved={() => void loadFilms()} />
      ) : (
        <Sources film={selected} onSaved={() => void loadFilms()} />
      )}
    </section>
  );
}
