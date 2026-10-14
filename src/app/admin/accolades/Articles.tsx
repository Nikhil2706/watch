"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { browseQuery, sourceBar, sourceColours } from "@/lib/admin/accolades-view";

import { useToasts } from "../Toasts";
import { Reader } from "./Reader";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Row {
  id: string;
  title: string;
  source_id: string;
  source_name: string;
  matched_count: number;
}

interface BySource {
  source_id: string;
  source_name: string;
  article_count: number;
  matched_count: number;
}

interface Browse {
  articles: Row[];
  hasMore: boolean;
  bySource: BySource[];
  totals: { total_articles: number; total_matched: number };
}

/** Everything scraped, across every source: find an article, read it, take passages from it. */
export function Articles({ film, onSaved }: { film: { imdbId: string; name: string } | null; onSaved: () => void }) {
  const { show } = useToasts();
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [source, setSource] = useState("");
  // The server takes "only" / "none"; the old console sent "matched" /
  // "unmatched", which it ignored, so this filter never filtered.
  const [matched, setMatched] = useState<"" | "only" | "none">("");
  const [data, setData] = useState<Browse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(t);
  }, [typed]);

  const fetchPage = useCallback(
    async (offset: number) => {
      try {
        const d = await adminApi<Browse>(browseQuery(q, source, matched, offset));
        setData(d);
        setRows((r) => (offset ? [...r, ...d.articles] : d.articles));
      } catch (e) {
        show("err", message(e));
      }
    },
    [q, source, matched, show],
  );

  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage]);

  const colours = useMemo(() => sourceColours((data?.bySource ?? []).map((s) => s.source_id)), [data?.bySource]);
  const max = Math.max(1, ...(data?.bySource ?? []).map((s) => s.article_count));

  return (
    <>
      <div className="adm-tools">
        <input className="adm-grow" value={typed} placeholder="Search scraped titles…" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
        <select value={matched} onChange={(e) => setMatched(e.target.value as typeof matched)} aria-label="Matched">
          <option value="">All articles</option>
          <option value="only">Matched to a film</option>
          <option value="none">Unmatched</option>
        </select>
      </div>
      {data ? (
        <>
          <div className="adm-ac-stats">
            <Stat value={data.totals.total_articles} label="Articles scraped" />
            <Stat value={data.totals.total_matched} label="Matched to your library" />
            <Stat value={data.bySource.length} label={`Source${data.bySource.length === 1 ? "" : "s"} with data`} />
          </div>
          <div className="adm-ac-sources">
            {data.bySource.map((s) => {
              const bar = sourceBar(s, max);
              return (
                <button key={s.source_id} type="button" className={`adm-ac-src${source === s.source_id ? " on" : ""}`} onClick={() => setSource(source === s.source_id ? "" : s.source_id)}>
                  <span className="adm-ac-src-dot" style={{ background: colours[s.source_id] }} />
                  <span className="adm-ac-src-name">{s.source_name}</span>
                  <span className="adm-ac-src-track">
                    <span style={{ width: `${bar.width}%`, background: colours[s.source_id] }} />
                    <span className="matched" style={{ width: `${bar.matched}%` }} />
                  </span>
                  <span className="hint">
                    {s.article_count.toLocaleString()} · {s.matched_count.toLocaleString()} matched
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      <div className={`adm-split${open ? " detail-open" : ""}`}>
        <button type="button" className="secondary adm-back" onClick={() => setOpen(null)}>
          ← Back to the list
        </button>
        <div className="adm-rail" role="list">
          {!data ? (
            <div className="empty adm-rail-empty">Loading…</div>
          ) : !rows.length ? (
            <div className="empty adm-rail-empty">Nothing scraped yet{q || source || matched ? " matching this filter." : "."}</div>
          ) : (
            rows.map((a) => (
              <div key={a.id} role="listitem" className={`adm-rail-item${open === a.id ? " sel" : ""}`}>
                <button type="button" className="adm-rail-open" onClick={() => setOpen(a.id)}>
                  <span className={`adm-dot ${a.matched_count > 0 ? "accent" : "dead"}`} style={a.matched_count > 0 ? { background: colours[a.source_id] } : undefined} />
                  <span className="adm-rail-name">
                    <span className="adm-rail-title">{a.title}</span>
                    <span className="adm-rail-sub">
                      {a.source_name} · {a.matched_count > 0 ? `${a.matched_count} matched` : "unmatched"}
                    </span>
                  </span>
                </button>
              </div>
            ))
          )}
          {data?.hasMore ? (
            <div className="adm-ac-more">
              <button type="button" className="secondary" onClick={() => void fetchPage(rows.length)}>
                Load more
              </button>
            </div>
          ) : null}
        </div>
        <div className="adm-pane">{open ? <Reader articleId={open} film={film} onClose={() => setOpen(null)} onSaved={onSaved} /> : <div className="adm-pane-empty">Pick an article on the left.</div>}</div>
      </div>
    </>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="adm-ac-stat">
      <div className="adm-ac-stat-val">{value.toLocaleString()}</div>
      <div className="hint">{label}</div>
    </div>
  );
}
