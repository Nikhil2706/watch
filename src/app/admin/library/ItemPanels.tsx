"use client";

import { useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { guessSearchName, type LibraryItem } from "@/lib/admin/library-rows";

/**
 * Identify, Type it in and Poster: the console's inline panels (openSearchPanel,
 * openManualPanel, openPosterPanel), opened under a film's actions.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Candidate {
  Name: string;
  ProductionYear?: number;
  ImageUrl?: string;
  Overview?: string;
}

export function IdentifyPanel({ item, onDone, onClose }: { item: LibraryItem; onDone: (msg: string) => void; onClose: () => void }) {
  const [name, setName] = useState(guessSearchName(item.name));
  const [year, setYear] = useState(item.year ? String(item.year) : "");
  const [link, setLink] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy"; text: string } | { kind: "error"; text: string } | { kind: "list"; candidates: Candidate[] }>({
    kind: "idle",
  });

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    setState({ kind: "busy", text: "Searching…" });
    try {
      const data = await adminApi<{ candidates: Candidate[] }>("/api/admin/library/identify", {
        method: "POST",
        body: { itemId: item.id, name: name.trim(), year: Number.parseInt(year, 10) || undefined, providerLink: link.trim() || undefined },
      });
      const candidates = data.candidates ?? [];
      setState(candidates.length ? { kind: "list", candidates } : { kind: "error", text: "No matches. Try “Type it in” instead." });
    } catch (err) {
      setState({ kind: "error", text: message(err) });
    }
  }

  async function apply(c: Candidate) {
    setState({ kind: "busy", text: "Applying…" });
    try {
      await adminApi("/api/admin/library/apply-match", { method: "POST", body: { itemId: item.id, candidate: c, path: item.path } });
      onDone(`Matched “${c.Name}”.`);
    } catch (err) {
      setState({ kind: "error", text: message(err) });
    }
  }

  return (
    <form className="adm-card adm-panel" onSubmit={search}>
      <div className="adm-row">
        <label>
          Search title
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="narrow">
          Year
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
      </div>
      <label>
        Or paste an IMDb/TMDB link
        <input value={link} placeholder="https://www.imdb.com/title/tt.../ or a TMDB link/id" onChange={(e) => setLink(e.target.value)} />
      </label>
      <div className="adm-acts">
        <button type="submit">Search</button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
      {state.kind === "busy" || state.kind === "error" ? <p className="hint">{state.text}</p> : null}
      {state.kind === "list"
        ? state.candidates.map((c, i) => (
            <button key={i} type="button" className="adm-candidate" onClick={() => apply(c)}>
              {c.ImageUrl && c.ImageUrl !== "N/A" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.ImageUrl} alt="" />
              ) : (
                <span className="adm-candidate-noimg" />
              )}
              <span>
                <span className="adm-candidate-name">
                  {c.Name}
                  {c.ProductionYear ? ` (${c.ProductionYear})` : ""}
                </span>
                {c.Overview ? <span className="adm-candidate-overview">{c.Overview}</span> : null}
              </span>
            </button>
          ))
        : null}
      <MiniseriesInOneFile item={item} defaultQuery={name} onDone={onDone} />
    </form>
  );
}

/**
 * For a TV mini-series the library keeps as one file (Salem's Lot, 1979):
 * film search can't find it, because TMDB lists it only as a show. Pick the
 * show, and the file is linked to it and named after it
 * (/api/admin/library/series-in-one-file).
 */
function MiniseriesInOneFile({ item, defaultQuery, onDone }: { item: LibraryItem; defaultQuery: string; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [shows, setShows] = useState<Array<{ tmdbId: number; name: string; year: number | null }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function find() {
    setBusy(true);
    setNote(null);
    try {
      const r = await adminApi<{ shows: Array<{ tmdbId: number; name: string; year: number | null }> }>(
        `/api/admin/library/series-in-one-file?q=${encodeURIComponent(query.trim())}`,
      );
      setShows(r.shows);
      if (!r.shows.length) setNote("TMDB has no show by that name.");
    } catch (err) {
      setNote(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function use(tmdbId: number) {
    if (!item.path) return;
    setBusy(true);
    setNote("Linking it and renaming it after the show…");
    try {
      const r = await adminApi<{ name: string; year: number | null; episodes: number | null }>("/api/admin/library/series-in-one-file", {
        method: "POST",
        body: { itemId: item.id, path: item.path, tmdbId },
      });
      onDone(`Now “${r.name}”${r.year ? ` (${r.year})` : ""}, a ${r.episodes ?? "multi"}-part mini-series in one file.`);
    } catch (err) {
      setNote(message(err));
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <p className="hint">
        A TV mini-series kept as one file (two or three parts in one video)?{" "}
        <button type="button" className="linklike" onClick={() => setOpen(true)}>
          Find it among TV shows
        </button>
      </p>
    );
  }
  return (
    <div className="adm-plan">
      <p className="hint">
        TMDB lists a mini-series only as a show, so film search can&apos;t find it. Pick the show: this file is linked to it, named after
        it, and given its summary and poster. It stays one film here. Its IMDb id is kept, for ratings.
      </p>
      <div className="adm-row">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Show name" />
        <button type="button" disabled={busy || !query.trim()} onClick={() => void find()}>
          Search TV shows
        </button>
      </div>
      {note ? <p className="hint">{note}</p> : null}
      {shows?.map((s) => (
        <button key={s.tmdbId} type="button" className="adm-candidate" disabled={busy} onClick={() => void use(s.tmdbId)}>
          <span className="adm-candidate-noimg" />
          <span>
            <span className="adm-candidate-name">
              {s.name}
              {s.year ? ` (${s.year})` : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function ManualPanel({ item, onDone, onClose }: { item: LibraryItem; onDone: (msg: string) => void; onClose: () => void }) {
  const [name, setName] = useState(guessSearchName(item.name));
  const [year, setYear] = useState(item.year ? String(item.year) : "");
  const [overview, setOverview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give it a title.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await adminApi("/api/admin/library/manual-metadata", {
        method: "POST",
        body: { itemId: item.id, name: name.trim(), overview: overview.trim(), year: Number.parseInt(year, 10) || undefined, path: item.path },
      });
      onDone(`Saved “${name.trim()}”.`);
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <form className="adm-card adm-panel" onSubmit={save}>
      <div className="adm-row">
        <label>
          Title
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="narrow">
          Year
          <input type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </label>
      </div>
      <label>
        Overview
        <input value={overview} placeholder="A line or two about it" onChange={(e) => setOverview(e.target.value)} />
      </label>
      {error ? <div className="error">{error}</div> : null}
      <div className="adm-acts">
        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

interface Art {
  fullUrl: string;
  thumbUrl: string;
  language: string | null;
  width: number;
  height: number;
  voteAverage: number | null;
}
const ART_KINDS = [
  ["poster", "Poster"],
  ["backdrop", "Backdrop"],
  ["logo", "Title logo"],
] as const;
type ArtKind = (typeof ART_KINDS)[number][0];

export function PosterPanel({ item, onDone, onClose }: { item: LibraryItem; onDone: (msg: string) => void; onClose: () => void }) {
  const [art, setArt] = useState<{ poster: Art[]; backdrop: Art[]; logo: Art[]; source: string } | null>(null);
  const [kind, setKind] = useState<ArtKind>("poster");
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    adminApi<{ posters?: Art[]; backdrops?: Art[]; logos?: Art[]; source?: string }>(
      `/api/admin/library/poster-options?itemId=${encodeURIComponent(item.id)}`,
    )
      .then((d) => {
        if (live) setArt({ poster: d.posters ?? [], backdrop: d.backdrops ?? [], logo: d.logos ?? [], source: d.source ?? "live" });
      })
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [item.id]);

  async function apply(a: Art) {
    setApplying(a.fullUrl);
    try {
      await adminApi("/api/admin/library/set-poster", { method: "POST", body: { itemId: item.id, imageUrl: a.fullUrl, kind } });
      onDone(`${kind === "backdrop" ? "Backdrop" : kind === "logo" ? "Title logo" : "Poster"} updated.`);
    } catch (e) {
      setError(message(e));
      setApplying(null);
    }
  }

  if (error)
    return (
      <div className="adm-card adm-panel">
        <div className="error">{error}</div>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    );
  if (!art)
    return (
      <div className="adm-card adm-panel">
        <p className="hint">Loading artwork…</p>
      </div>
    );

  const list = art[kind];
  return (
    <div className="adm-card adm-panel">
      <div className="adm-chips adm-chips-sub">
        {ART_KINDS.map(([k, label]) => (
          <button key={k} type="button" className={`adm-chip adm-chip-sub${kind === k ? " on" : ""}`} disabled={!art[k].length} onClick={() => setKind(k)}>
            {label} <b>{art[k].length}</b>
          </button>
        ))}
        {/* Where it came from says whether the grid is complete. */}
        <span className="hint">
          {art.source === "cache" ? "from the local TMDB store" : "asked TMDB live — this film is not in the store yet, so only posters are offered"}
        </span>
      </div>
      {list.length ? (
        <div className={`adm-art-grid${kind === "poster" ? "" : " wide"}`}>
          {list.slice(0, 30).map((a) => (
            <button
              key={a.fullUrl}
              type="button"
              className="adm-art-tile"
              style={applying === a.fullUrl ? { opacity: 0.5 } : undefined}
              disabled={applying !== null}
              onClick={() => apply(a)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.thumbUrl} alt="" loading="lazy" />
              <span className="adm-art-sub">
                {a.language || "no text"} · {a.width}×{a.height} · ★ {(a.voteAverage ?? 0).toFixed(1)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="hint">TMDB has none of these for this title.</p>
      )}
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
