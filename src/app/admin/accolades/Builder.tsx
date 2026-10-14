"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { slotBody } from "@/lib/admin/accolades-view";

import { useToasts } from "../Toasts";
import { LibrarySearch } from "./LibrarySearch";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Entry {
  id: string;
  slot: number;
  raw_title: string;
  blurb_text: string | null;
  imdb_id: string | null;
}

interface Accolade {
  id: string;
  name: string;
  entries: Entry[];
}

/**
 * The curator's own rankings — a top ten, a season, a director's best.
 * Entries resolve to films in the library and show under Accolades on the
 * film's page.
 */
export function Builder({ onChanged }: { onChanged: () => void }) {
  const { show } = useToasts();
  const [list, setList] = useState<Accolade[] | null>(null);
  const [newName, setNewName] = useState("");

  const load = useCallback(async () => {
    try {
      setList((await adminApi<{ accolades: Accolade[] }>("/api/admin/accolades/builder")).accolades ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) show("ok", ok);
      await load();
      onChanged();
      return true;
    } catch (e) {
      show("err", message(e));
      return false;
    }
  };

  return (
    <section className="adm-card">
      <div className="adm-row">
        <div className="adm-grow">
          <h2 className="adm-card-title">Accolade lists</h2>
          <p className="hint">Your own rankings — a top ten, a season, a director’s best. Entries resolve to films in the library, and show up under Accolades on the film’s page.</p>
        </div>
      </div>
      <form
        className="adm-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          void act(() => adminApi("/api/admin/accolades/builder", { method: "POST", body: { name: newName.trim() } }), "Created.").then((ok) => ok && setNewName(""));
        }}
      >
        <input className="adm-grow" value={newName} placeholder="Name a new list, e.g. 'Best of 2025'" onChange={(e) => setNewName(e.target.value)} />
        <button type="submit" className="secondary" disabled={!newName.trim()}>
          New accolade
        </button>
      </form>
      {!list ? <p className="hint">Loading…</p> : !list.length ? <p className="hint">Nothing built yet — name one above to start.</p> : null}
      {list?.map((a) => <AccoladeEditor key={a.id} a={a} act={act} />)}
    </section>
  );
}

function AccoladeEditor({ a, act }: { a: Accolade; act: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean> }) {
  const [name, setName] = useState(a.name);
  /** New rows waiting to be saved, each with the rank it will enter at. */
  const [adding, setAdding] = useState<number[]>([]);
  const base = `/api/admin/accolades/builder/${encodeURIComponent(a.id)}`;

  useEffect(() => setName(a.name), [a.name]);

  const rows: Array<{ kind: "entry"; e: Entry; i: number } | { kind: "new"; at: number; key: string }> = [];
  a.entries.forEach((e, i) => {
    adding.filter((at) => at === i).forEach((at, n) => rows.push({ kind: "new", at, key: `n${at}-${n}` }));
    rows.push({ kind: "entry", e, i });
  });
  adding.filter((at) => at >= a.entries.length).forEach((at, n) => rows.push({ kind: "new", at, key: `end${n}` }));

  const dropNew = (at: number) => setAdding((l) => {
    const k = l.indexOf(at);
    return k < 0 ? l : [...l.slice(0, k), ...l.slice(k + 1)];
  });

  return (
    <details className="adm-ac-list">
      <summary>
        {a.name} <span className="hint">{a.entries.length} slot{a.entries.length === 1 ? "" : "s"}</span>
      </summary>
      <div className="adm-row">
        <input className="adm-grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <button type="button" className="secondary" disabled={!name.trim() || name.trim() === a.name} onClick={() => void act(() => adminApi(base, { method: "PATCH", body: { name: name.trim() } }), "Renamed.")}>
          Rename
        </button>
        <button type="button" className="secondary" title="Picks can start from this list" onClick={() => window.location.assign("/admin/picks")}>
          Make a pick
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            if (!confirm("Delete this whole accolade list? This can't be undone.")) return;
            void act(() => adminApi(base, { method: "DELETE" }), "Deleted.");
          }}
        >
          Delete list
        </button>
      </div>
      {rows.map((r) =>
        r.kind === "entry" ? (
          <SlotRow
            key={r.e.id}
            rank={r.i}
            total={a.entries.length}
            entry={r.e}
            act={act}
            base={base}
            onInsertAbove={() => setAdding((l) => [...l, r.i])}
          />
        ) : (
          <SlotRow key={r.key} rank={r.at} total={a.entries.length} insertAt={r.at} act={act} base={base} onDiscard={() => dropNew(r.at)} />
        ),
      )}
      <div className="adm-row">
        <button type="button" className="secondary" onClick={() => setAdding((l) => [...l, a.entries.length + l.filter((x) => x >= a.entries.length).length])}>
          Add at the end
        </button>
      </div>
    </details>
  );
}

function SlotRow({
  rank,
  total,
  entry,
  insertAt,
  act,
  base,
  onInsertAbove,
  onDiscard,
}: {
  rank: number;
  total: number;
  entry?: Entry;
  insertAt?: number;
  act: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
  base: string;
  onInsertAbove?: () => void;
  onDiscard?: () => void;
}) {
  const { show } = useToasts();
  const [title, setTitle] = useState(entry?.raw_title ?? "");
  const [blurb, setBlurb] = useState(entry?.blurb_text ?? "");
  /** Picked from the search: saved with its exact id, not guessed from the title. */
  const [picked, setPicked] = useState<{ imdbId: string; year: number | null } | null>(null);
  const [to, setTo] = useState("");
  const isNew = insertAt !== undefined;

  const save = () => {
    const body = slotBody({ title, blurb, imdbId: picked?.imdbId ?? null, year: picked?.year ?? null, slot: entry?.slot ?? null, insertAt: isNew ? insertAt : null });
    if ("error" in body) return show("err", String(body.error));
    void act(() => adminApi(`${base}/entries`, { method: "POST", body }), "Saved.").then((ok) => ok && isNew && onDiscard?.());
  };

  const entryPath = entry ? `${base}/entries/${encodeURIComponent(entry.id)}` : "";

  return (
    <div className={`adm-ac-slot${isNew ? " new" : ""}`}>
      <span className="adm-ac-rank" title={isNew ? "Enters at this rank" : "Rank"}>
        #{rank + 1}
      </span>
      <div className="adm-grow">
        <LibrarySearch
          episodes
          value={title}
          onType={(v) => {
            setTitle(v);
            setPicked(null);
          }}
          placeholder="Search your library…"
          emptyNote="Not in your library — saved as typed, and it links itself if it's ever added."
          onPick={(r) => {
            setTitle(r.name);
            setPicked({ imdbId: r.imdbId, year: r.year });
          }}
        />
        <textarea value={blurb} placeholder="Blurb (optional)" onChange={(e) => setBlurb(e.target.value)} />
        <div className="hint">
          {picked ? "Linked — Save to keep it." : entry ? (entry.imdb_id ? "Matched" : "Not yet in your library — will auto-link if it's ever added") : ""}
        </div>
      </div>
      <div className="adm-ac-acts">
        {entry ? (
          <>
            <input className="adm-ac-to" type="number" min={1} max={total} placeholder="#" title="Move to this rank" value={to} onChange={(e) => setTo(e.target.value)} />
            <button
              type="button"
              className="secondary"
              title="Move to that rank"
              onClick={() => {
                const wanted = Number(to);
                if (!Number.isInteger(wanted) || wanted < 1 || wanted > total) return show("err", `Pick a rank from 1 to ${total}.`);
                void act(() => adminApi(`${entryPath}/move`, { method: "POST", body: { position: wanted - 1 } })).then(() => setTo(""));
              }}
            >
              Go
            </button>
            <button type="button" className="secondary" title="Insert a new film above this one" onClick={onInsertAbove}>
              +
            </button>
            <button type="button" className="secondary" title="Move up" disabled={rank === 0} onClick={() => void act(() => adminApi(`${entryPath}/move`, { method: "POST", body: { direction: "up" } }))}>
              ↑
            </button>
            <button type="button" className="secondary" title="Move down" disabled={rank === total - 1} onClick={() => void act(() => adminApi(`${entryPath}/move`, { method: "POST", body: { direction: "down" } }))}>
              ↓
            </button>
          </>
        ) : null}
        <button type="button" onClick={save}>
          Save
        </button>
        <button
          type="button"
          className="secondary"
          title={entry ? "Remove from the list" : "Discard"}
          onClick={() => {
            if (!entry) return onDiscard?.();
            if (!confirm(`Remove "${entry.raw_title}" from this list?`)) return;
            void act(() => adminApi(entryPath, { method: "DELETE" }), "Removed.");
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
