"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { daysUntil } from "@/lib/admin/library-rows";

import { useToasts } from "../Toasts";

/**
 * "Folders…": the library's own folders, to tick and scan, and to mark for
 * deletion in 30 days. Ported from curator.html (fp*, lwRunScan, lwScanCheck).
 *
 * A whole-library scan takes minutes, so its progress is asked of Jellyfin
 * every four seconds while it runs — whoever started it — and checked once on
 * arrival. A folder scan has no progress to report; the list is watched until
 * it stops changing (the same count twice, a few seconds apart, after at least
 * six seconds; two minutes at most).
 */

export interface ScanState {
  running: boolean;
  percent?: number | null;
  text?: string | null;
  lastResult?: string | null;
}

interface Folder {
  path: string;
  name: string;
  files: number;
  folders: number;
  marked?: boolean;
  leavesAt?: number | null;
}
interface Removal {
  folder: string;
  titles: number;
  deleteAt: number;
}

export function FoldersPanel({
  open,
  onClose,
  itemCount,
  onScan,
  onFinished,
}: {
  open: boolean;
  onClose: () => void;
  itemCount: number;
  onScan: (s: ScanState | null) => void;
  onFinished: (before: number, how: { ok: boolean; prefix: string }) => Promise<void>;
}) {
  const { show } = useToasts();
  const [kids, setKids] = useState<Record<string, Folder[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [removals, setRemovals] = useState<Removal[]>([]);
  const [busy, setBusy] = useState(false);
  const watch = useRef({ running: false, timer: null as ReturnType<typeof setTimeout> | null, startedHere: false, tries: 0, before: 0 });
  const countRef = useRef(itemCount);
  countRef.current = itemCount;

  const loadLevel = useCallback(async (path: string, force = false) => {
    if (!force && kids[path]) return;
    const data = await adminApi<{ folders: Folder[] }>(`/api/admin/library/folders?path=${encodeURIComponent(path)}`);
    setKids((k) => ({ ...k, [path]: data.folders ?? [] }));
  }, [kids]);

  const loadRemovals = useCallback(async () => {
    try {
      const data = await adminApi<{ removals: Removal[] }>("/api/admin/library/removals");
      setRemovals(data.removals ?? []);
    } catch {
      /* the panel works without it */
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    Promise.all([loadLevel(""), loadRemovals()]).catch((e) => show("err", e instanceof Error ? e.message : String(e)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- a whole-library scan, while it runs ------------------------ */

  const check = useCallback(async () => {
    const w = watch.current;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    try {
      const st = await adminApi<ScanState>("/api/admin/library/scan");
      const was = w.running;
      w.running = Boolean(st.running);
      onScan(st.running ? st : null);
      if (st.running) {
        if (!was) w.before = countRef.current;
        w.timer = setTimeout(check, 4000);
        return;
      }
      if (was) {
        w.startedHere = false;
        const failed = Boolean(st.lastResult && st.lastResult !== "Completed");
        await onFinished(w.before, {
          ok: !failed,
          prefix: failed ? `Library scan ended: ${st.lastResult!.toLowerCase()}. ` : "Library scan finished. ",
        });
      } else if (w.startedHere) {
        // Asked for a moment ago and Jellyfin has not begun yet: keep looking.
        w.tries += 1;
        if (w.tries < 8) w.timer = setTimeout(check, 2500);
        else {
          w.startedHere = false;
          w.tries = 0;
        }
      }
    } catch {
      // Jellyfin too busy to answer is itself likely during a scan.
      if (w.running || w.startedHere) w.timer = setTimeout(check, 6000);
    }
  }, [onScan, onFinished]);

  useEffect(() => {
    void check();
    const w = watch.current;
    return () => {
      if (w.timer) clearTimeout(w.timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** A folder scan: watch the listing until it stops changing. */
  async function watchFolderScan(names: string[], before: number) {
    const started = Date.now();
    let last = -1;
    const label = `Scanning ${names.length === 1 ? `“${names[0]!.split("/").pop()}”` : `${names.length} folders`}`;
    onScan({ running: true, percent: null, text: label });
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      let count: number;
      try {
        count = ((await adminApi<{ items: unknown[] }>("/api/admin/library/browse")).items ?? []).length;
      } catch {
        break;
      }
      const waited = Date.now() - started;
      onScan({
        running: true,
        percent: null,
        text: label + (count !== before ? ` — ${Math.abs(count - before)}${count > before ? " new so far" : " gone so far"}` : ""),
      });
      if ((count === last && waited >= 6000) || waited > 120000) break;
      last = count;
    }
    onScan(null);
  }

  async function runScan(folders: string[]) {
    const before = countRef.current;
    setBusy(true);
    try {
      const data = await adminApi<{ scope?: string } | null>("/api/admin/library/scan", {
        method: "POST",
        body: folders.length ? { folders } : null,
      });
      const wholeLibrary = Boolean(folders.length && data && data.scope === "library");
      if (!folders.length || wholeLibrary) {
        // Minutes, not seconds: the progress line takes it from here.
        const w = watch.current;
        w.startedHere = true;
        w.tries = 0;
        w.before = before;
        onScan({ running: true, percent: null });
        show(
          "ok",
          wholeLibrary
            ? "Jellyfin has no folder above that one yet, so the whole library is being scanned. Progress is shown beside the buttons."
            : "Scanning the whole library. Progress is shown beside the buttons.",
        );
        onClose();
        setTimeout(check, 1500);
        return;
      }
      await watchFolderScan(folders, before);
      await onFinished(before, { ok: true, prefix: "Scan finished. " });
      setChecked({});
      onClose();
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /* ---- marking folders to be deleted ------------------------------ */

  function findFolder(path: string): Folder | null {
    for (const list of Object.values(kids)) for (const f of list) if (f.path === path) return f;
    return null;
  }

  async function toggleRemoval(path: string) {
    const folder = findFolder(path);
    if (!folder) return;
    const marking = !folder.marked;
    // At once, before the answer: the next folder can be pressed straight away.
    setKids((k) =>
      Object.fromEntries(
        Object.entries(k).map(([p, list]) => [
          p,
          list.map((f) => (f.path === path ? { ...f, marked: marking, leavesAt: marking ? Date.now() + 30 * 86_400_000 : null } : f)),
        ]),
      ),
    );
    try {
      await adminApi("/api/admin/library/removals", { method: "POST", body: { action: marking ? "mark" : "unmark", folder: path } });
      // The server knows dates inherited from a folder further up: read the open levels again.
      const openLevels = Object.keys(kids);
      const fresh: Record<string, Folder[]> = {};
      await Promise.all(
        openLevels.map(async (p) => {
          const d = await adminApi<{ folders: Folder[] }>(`/api/admin/library/folders?path=${encodeURIComponent(p)}`);
          fresh[p] = d.folders ?? [];
        }),
      );
      setKids(fresh);
      await loadRemovals();
      show("ok", marking ? `“${folder.name}” will be deleted in 30 days. Press it again to keep it.` : `“${folder.name}” is staying.`);
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    }
  }

  function toggleOpen(path: string) {
    const next = !expanded[path];
    setExpanded({ ...expanded, [path]: next });
    if (next) loadLevel(path).catch((e) => show("err", e instanceof Error ? e.message : String(e)));
  }

  if (!open) return null;

  const chosen = Object.keys(checked).filter((k) => checked[k]);
  const now = Date.now();

  function rowsFor(path: string, depth: number): React.ReactNode[] {
    const out: React.ReactNode[] = [];
    for (const f of kids[path] ?? []) {
      const isOpen = Boolean(expanded[f.path]);
      const bits: string[] = [];
      if (f.files) bits.push(`${f.files} file${f.files === 1 ? "" : "s"}`);
      if (f.folders) bits.push(`${f.folders} folder${f.folders === 1 ? "" : "s"}`);
      const leaving = f.leavesAt ? daysUntil(f.leavesAt, now) : null;
      out.push(
        <div key={f.path} className={`adm-fp-row${leaving !== null ? " leaving" : ""}`} style={{ paddingLeft: 8 + depth * 20 }}>
          <button type="button" className="adm-fp-twist" disabled={!f.folders} aria-expanded={isOpen} onClick={() => toggleOpen(f.path)}>
            {isOpen ? "▾" : "▸"}
          </button>
          <input
            type="checkbox"
            aria-label={`Scan ${f.name}`}
            checked={Boolean(checked[f.path])}
            onChange={(e) => setChecked({ ...checked, [f.path]: e.target.checked })}
          />
          <span className="adm-fp-name">{f.name}</span>
          <span className="hint">{bits.join(" · ") || "empty"}</span>
          {f.marked ? (
            <button type="button" className="secondary adm-fp-del" title="Press to keep this folder" onClick={() => toggleRemoval(f.path)}>
              Deleted in {leaving} day{leaving === 1 ? "" : "s"} · Keep
            </button>
          ) : leaving !== null ? (
            <span className="hint">
              goes with the folder above, in {leaving} day{leaving === 1 ? "" : "s"}
            </span>
          ) : (
            <button
              type="button"
              className="secondary adm-fp-del"
              title="Mark this folder and everything in it to be deleted in 30 days"
              onClick={() => toggleRemoval(f.path)}
            >
              Delete in 30 days
            </button>
          )}
        </div>,
      );
      if (isOpen) {
        out.push(
          ...(kids[f.path]
            ? rowsFor(f.path, depth + 1)
            : [
                <div key={`${f.path}:loading`} className="adm-fp-row hint" style={{ paddingLeft: 34 + (depth + 1) * 20 }}>
                  Loading…
                </div>,
              ]),
        );
      }
    }
    return out;
  }

  return (
    <div className="adm-card adm-folders">
      <div className="adm-fp-head">
        <strong>Folders</strong>
        <button type="button" disabled={!chosen.length || busy} onClick={() => runScan(chosen)}>
          {busy ? "Scanning…" : chosen.length ? `Scan ${chosen.length} folder${chosen.length === 1 ? "" : "s"}` : "Scan the ticked folders"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            if (
              confirm(
                "Scan the whole library?\n\nThis takes several minutes and keeps the media server busy, so anyone watching may see playback stall. Ticking the folders the new files are in takes seconds.",
              )
            )
              void runScan([]);
          }}
        >
          Scan the whole library
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {removals.length ? (
        <div className="adm-fp-leaving">
          <b>
            {removals.length} folder{removals.length === 1 ? "" : "s"} marked to be deleted
          </b>{" "}
          ({removals.reduce((n, r) => n + r.titles, 0)} titles):{" "}
          {removals.map((r) => `${r.folder} in ${daysUntil(r.deleteAt, now)}d`).join(", ")}
        </div>
      ) : null}
      <div className="adm-fp-tree">
        {kids[""] ? (rowsFor("", 0).length ? rowsFor("", 0) : <div className="adm-fp-row hint">No folders.</div>) : <div className="adm-fp-row hint">Loading…</div>}
      </div>
      <p className="hint">
        Tick folders to scan them for new files; ticking a folder covers everything inside it. “Delete in 30 days” marks a folder at
        one press: the films in it show as leaving soon on the site, and on the date the folder and everything in it is deleted from
        the library and the drive. Press it again any time before then to keep the folder.
      </p>
    </div>
  );
}
