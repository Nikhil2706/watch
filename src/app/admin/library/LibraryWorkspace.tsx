"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  BULK_PATCH,
  BULK_VERB,
  buildRows,
  bulkRequest,
  filterChips,
  groupEpisodesLabel,
  patchItems,
  railSub,
  reasonChips,
  rowById,
  scanReport,
  scannedAgo,
  SORTS,
  stateDot,
  toggleFilter,
  toggleReason,
  visibleRows,
  type BulkAction,
  type FeatureGuess,
  type FilterKey,
  type LibraryItem,
  type ReasonKey,
  type Row,
  type SortKey,
  type SpecialFeature,
} from "@/lib/admin/library-rows";

import { useToasts } from "../Toasts";
import { FilmPane, ShowPane } from "./Panes";
import { FoldersPanel, type ScanState } from "./FoldersPanel";
import { Thumb } from "./Thumb";

/**
 * The Library tab: the console's workspace, ported (curator.html's lw*).
 *
 * One list, loaded on arrival. The rail on the left is for FINDING — poster,
 * name, one status dot. The pane on the right is for DOING. On a phone only
 * one side shows at a time, and Back returns to the list.
 */

export interface LibraryContext {
  items: LibraryItem[];
  rows: Row[];
  features: Record<string, SpecialFeature>;
  /** Reads the library again; resolves with the new items (null if it failed or one was already running). */
  reload: () => Promise<LibraryItem[] | null>;
  patch: (id: string, changes: Partial<LibraryItem>) => void;
  select: (id: string) => void;
  setFeatures: (list: SpecialFeature[]) => void;
}

const NARROW = "(max-width: 700px)";

export function LibraryWorkspace() {
  const { show } = useToasts();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [features, setFeatureMap] = useState<Record<string, SpecialFeature>>({});
  const [guesses, setGuesses] = useState<Record<string, FeatureGuess>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<FilterKey[]>(["needs"]);
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [sort, setSort] = useState<SortKey>("needs");
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [detailOpen, setDetailOpen] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [scan, setScan] = useState<ScanState | null>(null);
  const [guessing, setGuessing] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [addTo, setAddTo] = useState<string | null>(null);
  const loading = useRef(false);
  const splitRef = useRef<HTMLDivElement>(null);

  const setFeatures = useCallback((list: SpecialFeature[]) => {
    setFeatureMap(Object.fromEntries(list.map((f) => [f.itemId, f])));
    // A confirmed suggestion is no longer a suggestion.
    setGuesses((g) => {
      const next = { ...g };
      for (const f of list) delete next[f.itemId];
      return next;
    });
  }, []);

  const reload = useCallback(async (): Promise<LibraryItem[] | null> => {
    if (loading.current) return null;
    loading.current = true;
    try {
      const data = await adminApi<{ items: LibraryItem[]; lastScanAt: number | null }>("/api/admin/library/browse");
      const fresh = data.items ?? [];
      setItems(fresh);
      setLastScanAt(data.lastScanAt ?? null);
      setLoaded(true);
      setLoadError(null);
      // Merged onto the rows; a library that loads without it is still usable.
      adminApi<{ features: SpecialFeature[] }>("/api/admin/special-features")
        .then((d) => setFeatureMap(Object.fromEntries((d.features ?? []).map((f) => [f.itemId, f]))))
        .catch(() => {});
      return fresh;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setLoadError(message);
      show("err", message);
      return null;
    } finally {
      loading.current = false;
    }
  }, [show]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = useMemo(() => buildRows(items, features, guesses), [items, features, guesses]);
  const view = { query, filters, reason, sort };
  const visible = useMemo(() => visibleRows(rows, view), [rows, query, filters, reason, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  const chips = useMemo(() => filterChips(rows, filters), [rows, filters]);
  const reasons = useMemo(() => reasonChips(rows, filters, reason), [rows, filters, reason]);
  const current = rowById(rows, items, selected);

  // Keep the selection across a reload where it still exists.
  useEffect(() => {
    if (loaded && selected && !rowById(rows, items, selected)) setSelected(null);
  }, [loaded, rows, items, selected]);

  // Phone: Back closes the detail rather than leaving the page.
  useEffect(() => {
    const onPop = () => setDetailOpen(false);
    window.addEventListener("popstate", onPop);
    const mq = window.matchMedia(NARROW);
    const onChange = () => {
      if (!mq.matches) setDetailOpen(false);
    };
    mq.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("popstate", onPop);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const select = useCallback((id: string) => {
    setSelected(id);
    if (window.matchMedia(NARROW).matches) {
      setDetailOpen((open) => {
        if (!open) history.pushState({ admDetail: true }, "");
        return true;
      });
      setTimeout(() => splitRef.current?.scrollIntoView({ block: "start" }), 0);
    }
  }, []);

  function backToList() {
    if (history.state && (history.state as { admDetail?: boolean }).admDetail) history.back();
    else setDetailOpen(false);
  }

  const patch = useCallback((id: string, changes: Partial<LibraryItem>) => {
    setItems((list) => patchItems(list, id, changes));
  }, []);

  const ctx: LibraryContext = { items, rows, features, reload, patch, select, setFeatures };

  /* ---- toolbar ---------------------------------------------------- */

  const filmRows = visible.filter((r) => r.kind === "film");
  const allOn = filmRows.length > 0 && filmRows.every((r) => checked[r.id]);
  const picked = Object.keys(checked).filter((k) => checked[k]);

  function selectAllShown() {
    if (!filmRows.length) {
      show("err", "Nothing to select.");
      return;
    }
    const next = { ...checked };
    for (const r of filmRows) next[r.id] = !allOn;
    setChecked(next);
  }

  async function suggestFeatures() {
    setGuessing(true);
    try {
      const data = await adminApi<{ guesses: FeatureGuess[] }>("/api/admin/special-features/guess");
      const list = data.guesses ?? [];
      setGuesses(Object.fromEntries(list.map((g) => [g.itemId, g])));
      show(
        "ok",
        list.length
          ? `${list.length} possible special feature${list.length === 1 ? "" : "s"} — they are under “Needs you”.`
          : "Nothing in the library looks like a special feature.",
      );
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    } finally {
      setGuessing(false);
    }
  }

  /* ---- bulk ------------------------------------------------------- */

  async function bulk(action: BulkAction) {
    if (!picked.length) return;
    if (!confirm(`${BULK_VERB[action]} ${picked.length} selected file${picked.length === 1 ? "" : "s"}?`)) return;
    setBulkBusy(true);
    let done = 0;
    let failed = 0;
    // One at a time: these reach Jellyfin and OpenSubtitles, and thirty at
    // once on this box is how a tidy-up becomes an outage.
    for (const id of picked) {
      const it = items.find((i) => i.id === id);
      const req = it ? bulkRequest(action, it) : null;
      if (!req) {
        failed++;
        continue;
      }
      try {
        await adminApi(req.url, { method: "POST", body: req.body });
        done++;
        const p = BULK_PATCH[action];
        if (p) patch(id, p);
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setChecked({});
    show(failed ? "err" : "ok", `${done} done${failed ? `, ${failed} failed` : ""}.`);
  }

  function pickedPaths(): string[] {
    return picked.map((id) => items.find((i) => i.id === id)?.path).filter((p): p is string => Boolean(p));
  }

  async function groupNew() {
    const paths = pickedPaths();
    if (paths.length < 2) {
      show("err", "Tick at least two files.");
      return;
    }
    const name = prompt("Name this show:", "");
    if (!name) return;
    setBulkBusy(true);
    try {
      await adminApi("/api/admin/library/group", { method: "POST", body: { name, paths } });
      show("ok", `Grouped as ${name}.`);
      setChecked({});
      await reload();
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  const shows = rows.filter((r): r is Extract<Row, { kind: "show" }> => r.kind === "show").sort((a, b) => a.name.localeCompare(b.name));

  async function groupAdd() {
    const target = shows.find((s) => s.groupId === addTo);
    if (!target) {
      show("err", "Pick a show to add to.");
      return;
    }
    setBulkBusy(true);
    try {
      await adminApi("/api/admin/library/group-add", { method: "POST", body: { groupId: target.groupId, paths: pickedPaths() } });
      show("ok", `Added to ${target.name}.`);
      setChecked({});
      setAddTo(null);
      await reload();
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBulkBusy(false);
    }
  }

  async function groupEpisodes(key: string) {
    try {
      const r = await adminApi<{ files: number; name: string }>("/api/admin/library/group-episodes", { method: "POST", body: { key } });
      show("ok", `${r.files === 1 ? "1 episode" : `${r.files} episodes`} grouped into ${r.name}.`);
      await reload();
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    }
  }

  /* ---- scans ------------------------------------------------------ */

  const onScanFinished = useCallback(
    async (before: number, how: { ok: boolean; prefix: string }) => {
      const now = await reload();
      if (!now) return;
      const needing = buildRows(now, features, guesses).filter((r) => r.needsDecision).length;
      show(how.ok ? "ok" : "err", how.prefix + scanReport(now.length - before, needing));
    },
    [reload, features, guesses, show],
  );

  /* ---- render ----------------------------------------------------- */

  return (
    <section className="adm-lib">
      <div className="adm-chips" role="toolbar" aria-label="Filter">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`adm-chip${c.on ? " on" : ""}${c.alert ? " alert" : ""}`}
            disabled={!c.count}
            aria-pressed={c.on}
            onClick={() => {
              const next = toggleFilter({ filters, reason }, c.key);
              setFilters(next.filters);
              setReason(next.reason);
            }}
          >
            {c.label} <b>{c.count}</b>
          </button>
        ))}
      </div>
      {reasons.length ? (
        <div className="adm-chips adm-chips-sub">
          <span className="adm-chip-lead">because:</span>
          {reasons.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`adm-chip adm-chip-sub${c.on ? " on" : ""}`}
              aria-pressed={c.on}
              onClick={() => setReason(toggleReason(reason, c.key))}
            >
              {c.label} <b>{c.count}</b>
            </button>
          ))}
        </div>
      ) : null}

      <div className="adm-tools">
        <input
          type="search"
          className="adm-search"
          placeholder="Search title or filename…"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" onClick={selectAllShown}>
          {allOn ? "Clear selection" : "Select all shown"}
        </button>
        <button
          type="button"
          className="secondary"
          title="The library's folders: scan the ones with new files, or mark folders to be deleted"
          onClick={() => setFoldersOpen((o) => !o)}
        >
          Folders…
        </button>
        <button type="button" className="secondary" disabled={guessing} onClick={suggestFeatures}>
          {guessing ? "Looking…" : "Suggest special features"}
        </button>
        <span className="hint">{scannedAgo(lastScanAt, Date.now())}</span>
        {scan?.running ? (
          <span className="adm-scanning">
            <span className={`adm-scanbar${typeof scan.percent === "number" ? "" : " unknown"}`}>
              <span style={typeof scan.percent === "number" ? { width: `${scan.percent}%` } : undefined} />
            </span>
            <span>
              {scan.text || "Scanning the whole library"}
              {typeof scan.percent === "number" ? ` — ${scan.percent}%` : "…"}
            </span>
          </span>
        ) : null}
      </div>

      {picked.length >= 2 ? (
        <div className="adm-bulk">
          <strong>{picked.length} selected</strong>
          <button type="button" className="secondary" disabled={bulkBusy} onClick={groupNew}>
            Group as one show
          </button>
          <span className="adm-bulk-add">
            <select value={addTo ?? ""} onChange={(e) => setAddTo(e.target.value || null)} aria-label="Add to which show">
              <option value="">Add to an existing show…</option>
              {shows.map((s) => (
                <option key={s.groupId} value={s.groupId}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className="secondary" disabled={bulkBusy || !addTo} onClick={groupAdd}>
              Add
            </button>
          </span>
          <button type="button" className="secondary" disabled={bulkBusy} onClick={() => bulk("hide")}>
            Hide from the site
          </button>
          <button type="button" className="secondary" disabled={bulkBusy} onClick={() => bulk("whitelist")}>
            Show anyway
          </button>
          <button type="button" className="secondary" disabled={bulkBusy} onClick={() => bulk("subs")}>
            Fetch subtitles
          </button>
          <button type="button" className="secondary" onClick={() => setChecked({})}>
            Clear
          </button>
        </div>
      ) : null}

      <FoldersPanel
        open={foldersOpen}
        onClose={() => setFoldersOpen(false)}
        itemCount={items.length}
        onScan={setScan}
        onFinished={onScanFinished}
      />

      <div ref={splitRef} className={`adm-split${detailOpen ? " detail-open" : ""}`}>
        <button type="button" className="secondary adm-back" onClick={backToList}>
          ← Back to the list
        </button>
        <div className="adm-rail" role="list">
          {!loaded ? (
            <div className="empty adm-rail-empty">{loadError ?? "Loading…"}</div>
          ) : !visible.length ? (
            <div className="empty adm-rail-empty">Nothing here.</div>
          ) : (
            visible.map((r) => {
              const sub = railSub(r, view);
              return (
                <div key={r.id} role="listitem" className={`adm-rail-item${selected === r.id ? " sel" : ""}`}>
                  {r.kind === "film" ? (
                    <input
                      type="checkbox"
                      className="adm-rail-check"
                      aria-label={`Select ${r.name}`}
                      checked={Boolean(checked[r.id])}
                      onChange={(e) => setChecked({ ...checked, [r.id]: e.target.checked })}
                    />
                  ) : (
                    <span className="adm-rail-check" />
                  )}
                  <button type="button" className="adm-rail-open" onClick={() => select(r.id)}>
                    <span className={`adm-dot ${stateDot(r)}`} />
                    <Thumb url={r.poster} className="adm-thumb" />
                    <span className="adm-rail-name">
                      <span className="adm-rail-title">{r.name}</span>
                      {sub ? <span className="adm-rail-sub">{sub}</span> : null}
                    </span>
                  </button>
                  {r.kind === "film" && r.pendingEpisode ? (
                    <button type="button" className="secondary adm-rail-act" onClick={() => groupEpisodes(r.pendingEpisode!.key)}>
                      {groupEpisodesLabel(r.pendingEpisode)}
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="adm-pane">
          {!current ? (
            <div className="adm-pane-empty">{selected ? "That item is no longer in the list." : "Pick something on the left."}</div>
          ) : current.kind === "show" ? (
            <ShowPane key={current.id} row={current} ctx={ctx} />
          ) : (
            <FilmPane key={current.id} row={current} ctx={ctx} onGroupEpisodes={groupEpisodes} />
          )}
        </div>
      </div>
    </section>
  );
}
