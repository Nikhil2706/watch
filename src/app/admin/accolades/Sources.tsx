"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { lastJobNote, SOURCE_RUN_ROUTES, testRunReport, WIKI_LIST_PRESETS } from "@/lib/admin/accolades-view";

import { useToasts } from "../Toasts";
import { Reader } from "./Reader";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Source {
  id: string;
  name: string;
  kind: string;
  source_type: "web" | "pdf_upload";
  enabled: number | boolean;
  recentJobs?: Array<{ created_at: number | string; status: string; found_count?: number | null; matched_count?: number | null }>;
}

interface Book {
  id: string;
  title: string;
  matched_count: number;
  unmatched_count: number;
}

/** Where the writing comes from: web sources to switch on or off, lists to fetch, and uploaded books. */
export function Sources({ film, onSaved }: { film: { imdbId: string; name: string } | null; onSaved: () => void }) {
  const { show } = useToasts();
  const [sources, setSources] = useState<Source[] | null>(null);
  const [books, setBooks] = useState<Book[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [preset, setPreset] = useState(Object.keys(WIKI_LIST_PRESETS)[0]!);
  const [wikiStatus, setWikiStatus] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [s, b] = await Promise.all([
        adminApi<{ sources: Source[] }>("/api/admin/accolades/sources"),
        adminApi<{ articles: Book[] }>("/api/admin/accolades/sources/uploaded-books/articles"),
      ]);
      setSources(s.sources ?? []);
      setBooks(b.articles ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  };

  const yearEnd = () =>
    run("yearend", async () => {
      const r = await adminApi<{ entriesFound: number; listsProcessed: number; matchedCount: number }>("/api/admin/accolades/run-yearendlists", {
        method: "POST",
        body: { year: Number(year) || new Date().getFullYear() },
      });
      show("ok", `Found ${r.entriesFound} entries across ${r.listsProcessed} lists (${r.matchedCount} matched).`);
    });

  const wiki = () => {
    const p = WIKI_LIST_PRESETS[preset]!;
    setWikiStatus(`Fetching ${String(p.body.page_title)}…`);
    return run("wiki", async () => {
      try {
        const r = await adminApi<{ entriesFound: number; pageTitle: string; matchedCount: number }>("/api/admin/accolades/run-wikipedia-list", { method: "POST", body: p.body });
        setWikiStatus(`Found ${r.entriesFound} entries in "${r.pageTitle}" (${r.matchedCount} matched to library films).`);
      } catch (e) {
        setWikiStatus(`Failed: ${message(e)}`);
      }
    });
  };

  const upload = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return show("err", "Choose a PDF first.");
    return run("upload", async () => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/accolades/upload-book", { method: "POST", credentials: "same-origin", body: form });
      const txt = await res.text();
      let d: { filmsFound?: number; matchedCount?: number; message?: string } | null = null;
      try {
        d = txt ? JSON.parse(txt) : null;
      } catch {
        /* not JSON */
      }
      if (!res.ok) throw new Error(d?.message || txt || `HTTP ${res.status}`);
      show("ok", `Found ${d?.filmsFound ?? 0} films mentioned (${d?.matchedCount ?? 0} matched).`);
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  const web = (sources ?? []).filter((s) => s.source_type === "web");

  return (
    <>
      <section className="adm-card">
        <div className="adm-row">
          <div className="adm-grow">
            <h2 className="adm-card-title">Web sources</h2>
            <p className="hint">Where the writing comes from. Toggle one off and it stops being scraped.</p>
          </div>
          <input type="number" className="adm-ac-year" value={year} aria-label="Year" onChange={(e) => setYear(e.target.value)} />
          <button type="button" disabled={busy === "yearend"} onClick={() => void yearEnd()}>
            {busy === "yearend" ? "Running…" : "Run Year End Lists"}
          </button>
        </div>
        {!sources ? <p className="hint">Loading…</p> : null}
        <div className="adm-rows">
          {web.map((s) => {
            const route = SOURCE_RUN_ROUTES[s.id];
            return (
              <div key={s.id} className="adm-row">
                <div className="adm-grow">
                  {s.name}{" "}
                  <span className="hint">
                    {s.kind}
                    {lastJobNote(s.recentJobs?.[0])}
                  </span>
                </div>
                {route ? (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy === s.id}
                    onClick={() =>
                      void run(s.id, async () => {
                        const r = await adminApi<{ reviewsProcessed?: number; articlesProcessed?: number; matchedCount: number }>(route, { method: "POST", body: { limit: 10 } });
                        show("ok", testRunReport(r));
                      })
                    }
                  >
                    {busy === s.id ? "Running…" : "Test run"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`adm-ac-toggle${s.enabled ? " on" : ""}`}
                  aria-pressed={Boolean(s.enabled)}
                  onClick={() => void run(`t${s.id}`, async () => void (await adminApi(`/api/admin/accolades/sources/${encodeURIComponent(s.id)}/toggle`, { method: "POST" })))}
                >
                  {s.enabled ? "On" : "Off"}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">Wikipedia lists &amp; awards</h2>
        <div className="adm-row">
          <select className="adm-grow" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="List">
            {Object.entries(WIKI_LIST_PRESETS).map(([k, p]) => (
              <option key={k} value={k}>
                {p.label}
              </option>
            ))}
          </select>
          <button type="button" disabled={busy === "wiki"} onClick={() => void wiki()}>
            {busy === "wiki" ? "Running…" : "Run"}
          </button>
        </div>
        {wikiStatus ? <p className="hint">{wikiStatus}</p> : null}
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">Uploaded books</h2>
        <div className="adm-row">
          <input ref={fileRef} className="adm-grow" type="file" accept="application/pdf" />
          <button type="button" disabled={busy === "upload"} onClick={() => void upload()}>
            {busy === "upload" ? "Uploading…" : "Upload"}
          </button>
        </div>
        {!books ? null : !books.length ? (
          <p className="hint">Nothing uploaded yet.</p>
        ) : (
          <div className="adm-rows">
            {books.map((b) => (
              <div key={b.id} className="adm-row">
                <div className="adm-grow">
                  {b.title}{" "}
                  <span className="hint">
                    — {b.matched_count} matched{b.unmatched_count ? `, ${b.unmatched_count} unmatched` : ""}
                  </span>
                </div>
                <button type="button" className="secondary" onClick={() => setReading(reading === b.id ? null : b.id)}>
                  {reading === b.id ? "Close" : "Read full text"}
                </button>
              </div>
            ))}
          </div>
        )}
        {reading ? <Reader articleId={reading} film={film} onClose={() => setReading(null)} onSaved={onSaved} /> : null}
      </section>
    </>
  );
}
