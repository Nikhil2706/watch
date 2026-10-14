"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  visibleWorkerRows,
  workerChips,
  workerDot,
  workerRows,
  workerSub,
  type Candidate,
  type QueueJob,
  type WorkerFilter,
} from "@/lib/admin/worker-view";

import { useToasts } from "../Toasts";

/**
 * The Worker tab: files that would fall back to a live transcode, and the
 * conversion queue, as one list with the state on a chip. Ported from
 * curator.html's Worker workspace. The worker runs all the time; queuing a
 * file here is all it takes (it picks it up within about a minute, when
 * nobody is watching).
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const NARROW = "(max-width: 700px)";

export function WorkerWorkspace() {
  const { show } = useToasts();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [filter, setFilter] = useState<WorkerFilter>("needs");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);

  const loadJobs = useCallback(async () => {
    try {
      const d = await adminApi<{ jobs: QueueJob[] }>("/api/admin/worker/jobs");
      setJobs(d.jobs ?? []);
    } catch {
      /* the list still works without the queue */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const [c] = await Promise.all([adminApi<{ candidates: Candidate[] }>("/api/admin/worker/candidates"), loadJobs()]);
      setCandidates(c.candidates ?? []);
    } catch (e) {
      show("err", message(e));
      setCandidates([]);
    }
  }, [loadJobs, show]);

  useEffect(() => {
    void load();
  }, [load]);

  // While something is converting, keep its progress moving.
  const anyRunning = jobs.some((j) => j.status === "running" || j.status === "queued" || j.status === "pending");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void loadJobs(), 15000);
    return () => clearInterval(t);
  }, [anyRunning, loadJobs]);

  useEffect(() => {
    const onPop = () => setDetailOpen(false);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const rows = candidates ? workerRows(candidates, jobs) : [];
  const visible = visibleWorkerRows(rows, filter, query);
  const current = rows.find((r) => r.id === selected) ?? null;

  function select(id: string) {
    setSelected(id);
    if (window.matchMedia(NARROW).matches) {
      if (!detailOpen) history.pushState({ admDetail: true }, "");
      setDetailOpen(true);
    }
  }

  async function queue() {
    if (!current?.item) return;
    setBusy(true);
    try {
      const r = await adminApi<{ queued: boolean }>("/api/admin/worker/transform", {
        method: "POST",
        body: { path: current.item.path, title: current.item.name },
      });
      show("ok", r.queued ? `Queued “${current.name}”. The worker picks it up within about a minute.` : `“${current.name}” was already queued or processed before.`);
      await loadJobs();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  async function browserAudio() {
    if (!current?.item) return;
    setBusy(true);
    try {
      await adminApi("/api/admin/library/browser-audio", { method: "POST", body: { path: current.item.path } });
      show("ok", "Queued. The worker does it within a few minutes when nothing else is queued and nobody is watching; the result shows under Health.");
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="adm-lib">
      <div className="adm-row adm-list-head">
        <div className="adm-grow">
          <h2 className="adm-card-title">Conversion</h2>
          <p className="hint">
            Files that would fall back to a live transcode instead of playing directly in a browser, read from Jellyfin’s own analysis. Queue one
            and the worker picks it up within about a minute, when nobody is watching.
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="adm-chips" role="toolbar" aria-label="Filter">
        {workerChips(rows, filter).map((c) => (
          <button
            key={c.key}
            type="button"
            className={`adm-chip${c.on ? " on" : ""}${c.alert ? " alert" : ""}`}
            disabled={!c.count}
            aria-pressed={c.on}
            onClick={() => setFilter(c.key)}
          >
            {c.label} <b>{c.count}</b>
          </button>
        ))}
      </div>
      <div className="adm-tools">
        <input type="search" className="adm-search" placeholder="Search title or filename…" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={`adm-split${detailOpen ? " detail-open" : ""}`}>
        <button
          type="button"
          className="secondary adm-back"
          onClick={() => (history.state && (history.state as { admDetail?: boolean }).admDetail ? history.back() : setDetailOpen(false))}
        >
          ← Back to the list
        </button>
        <div className="adm-rail" role="list">
          {!candidates ? (
            <div className="empty adm-rail-empty">Loading…</div>
          ) : !visible.length ? (
            <div className="empty adm-rail-empty">Nothing here.</div>
          ) : (
            visible.map((r) => (
              <div key={r.id} role="listitem" className={`adm-rail-item${selected === r.id ? " sel" : ""}`}>
                <button type="button" className="adm-rail-open" onClick={() => select(r.id)}>
                  <span className={`adm-dot ${workerDot(r)}`} />
                  <span className="adm-rail-name">
                    <span className="adm-rail-title">{r.name}</span>
                    <span className="adm-rail-sub">{workerSub(r)}</span>
                  </span>
                </button>
              </div>
            ))
          )}
        </div>
        <div className="adm-pane">
          {!current ? (
            <div className="adm-pane-empty">{selected ? "That file is no longer listed." : "Pick a file on the left."}</div>
          ) : (
            <div>
              <h2 className="adm-title">
                {current.name} {current.year ? <span className="hint">({current.year})</span> : null}
              </h2>
              <div className="adm-sub">
                {[current.reason, current.quality, current.status === "audio" ? "needs browser audio" : current.status].filter(Boolean).join(" · ")}
              </div>
              <div className="adm-path">{current.path}</div>
              <div className="adm-acts">
                {current.status === "needs" && current.item ? (
                  <button type="button" disabled={busy} onClick={queue}>
                    Queue for conversion
                  </button>
                ) : current.status === "audio" && current.item ? (
                  <>
                    <button type="button" disabled={busy} onClick={browserAudio}>
                      Add browser audio now
                    </button>
                    <span className="hint">
                      The picture plays as it is; only a stereo AAC track is added, keeping every original track. The worker also does these by
                      itself, up to 20 a day.
                    </span>
                  </>
                ) : current.status === "running" || current.status === "paused" ? (
                  <span className="hint">Converting — {current.progress ?? 0}% done.</span>
                ) : current.status === "failed" || current.status === "error" ? (
                  <span className="hint">This one failed. The worker’s log, and Health → Conversions, have the reason.</span>
                ) : (
                  <span className="hint">Nothing to do for this one.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
