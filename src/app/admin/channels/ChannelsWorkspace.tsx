"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";

import { useToasts } from "../Toasts";

type OrderMode = "in_order" | "shuffle";
interface Entry {
  kind: "item" | "group" | "genre";
  ref: string;
  label: string;
}
interface ChannelSummary {
  id: string;
  name: string;
  orderMode: OrderMode;
  entries: number;
  programmes: number;
  runtimeMs: number;
  onNow: string | null;
}
interface ChannelDetail {
  channel: { id: string; name: string; orderMode: OrderMode };
  entries: Entry[];
  guide: Array<{ name: string; startsAt: number; endsAt: number }>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(ms / 60_000)} min`;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const KIND_LABEL: Record<Entry["kind"], string> = { item: "Programme", group: "Whole show", genre: "Genre rule" };

/**
 * Channels (channels.ts): make one, fill its lineup with films, episodes,
 * whole shows and genre rules, order it, and see its guide. Saving works the
 * lineup out into programmes; nothing streams until someone tunes in.
 */
export function ChannelsWorkspace() {
  const { show } = useToasts();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [newName, setNewName] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setChannels((await adminApi<{ channels: ChannelSummary[] }>("/api/admin/channels")).channels);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (!newName.trim()) return;
    try {
      const { id } = await adminApi<{ id: string }>("/api/admin/channels", { method: "POST", body: { name: newName } });
      setNewName("");
      await load();
      setOpen(id);
    } catch (e) {
      show("err", message(e));
    }
  }

  async function move(id: string, direction: -1 | 1) {
    await adminApi(`/api/admin/channels/${id}/move`, { method: "POST", body: { direction } }).catch((e) => show("err", message(e)));
    await load();
  }

  return (
    <div className="adm-rows">
      <div className="adm-card">
        <div className="adm-card-title">Channels</div>
        <p className="hint">
          Always-on lineups anyone can tune into, live, like Pluto TV. Nothing streams while nobody is watching: what&apos;s on is
          worked out from the clock when someone opens the guide or tunes in.
        </p>
        <div className="adm-row">
          <input
            className="adm-grow"
            placeholder="New channel, e.g. Buffy all day"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <button type="button" onClick={() => void create()} disabled={!newName.trim()}>
            Add channel
          </button>
        </div>
      </div>

      {channels?.length === 0 ? <p className="hint">No channels yet.</p> : null}
      {channels?.map((c, i) => (
        <div className="adm-card" key={c.id}>
          <div className="adm-row">
            <div className="adm-grow">
              <div className="adm-card-title">{c.name}</div>
              <div className="hint">
                {c.programmes} programmes · {hours(c.runtimeMs)} · {c.orderMode === "shuffle" ? "shuffled" : "in order"}
                {c.onNow ? ` · on now: ${c.onNow}` : c.entries ? " · nothing playable" : " · empty"}
              </div>
            </div>
            <button type="button" className="secondary" disabled={i === 0} onClick={() => void move(c.id, -1)} title="Earlier on the guide">
              ↑
            </button>
            <button type="button" className="secondary" disabled={i === channels.length - 1} onClick={() => void move(c.id, 1)} title="Later on the guide">
              ↓
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(open === c.id ? null : c.id)}>
              {open === c.id ? "Close" : "Edit"}
            </button>
          </div>
          {open === c.id ? <ChannelEditor id={c.id} onChanged={load} onDeleted={() => (setOpen(null), void load())} /> : null}
        </div>
      ))}
    </div>
  );
}

function ChannelEditor({ id, onChanged, onDeleted }: { id: string; onChanged: () => Promise<void>; onDeleted: () => void }) {
  const { show } = useToasts();
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [name, setName] = useState("");
  const [orderMode, setOrderMode] = useState<OrderMode>("in_order");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ entries: Entry[]; genres: string[] } | null>(null);
  const [genre, setGenre] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<ChannelDetail>(`/api/admin/channels/${id}`);
      setDetail(d);
      setName(d.channel.name);
      setOrderMode(d.channel.orderMode);
      setEntries(d.entries);
    } catch (e) {
      show("err", message(e));
    }
  }, [id, show]);

  useEffect(() => {
    void load();
  }, [load]);

  // Search as you type, a beat after the last key.
  useEffect(() => {
    const timer = setTimeout(() => {
      adminApi<{ entries: Entry[]; genres: string[] }>(`/api/admin/channels/search?q=${encodeURIComponent(q)}`)
        .then(setFound)
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const add = (e: Entry) => setEntries((list) => [...list, e]);
  const shift = (i: number, by: -1 | 1) =>
    setEntries((list) => {
      const j = i + by;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  async function save() {
    setSaving(true);
    try {
      const r = await adminApi<{ slots: number; runtimeMs: number }>(`/api/admin/channels/${id}`, {
        method: "PUT",
        body: { name, orderMode, entries },
      });
      show("ok", `Saved: ${r.slots} programmes, ${hours(r.runtimeMs)} before it loops.`);
      await load();
      await onChanged();
    } catch (e) {
      show("err", message(e));
    } finally {
      setSaving(false);
    }
  }

  async function rebuild() {
    try {
      const r = await adminApi<{ slots: number }>(`/api/admin/channels/${id}/rebuild`, { method: "POST" });
      show("ok", `Rebuilt: ${r.slots} programmes.`);
      await load();
      await onChanged();
    } catch (e) {
      show("err", message(e));
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the channel "${name}"? Its lineup goes with it; no files are touched.`)) return;
    await adminApi(`/api/admin/channels/${id}`, { method: "DELETE" }).catch((e) => show("err", message(e)));
    onDeleted();
  }

  if (!detail) return <p className="hint">Loading…</p>;
  return (
    <div className="adm-rows adm-channel-editor">
      <div className="adm-row">
        <input className="adm-grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Channel name" />
        <select value={orderMode} onChange={(e) => setOrderMode(e.target.value as OrderMode)} aria-label="Order">
          <option value="in_order">Play in order</option>
          <option value="shuffle">Shuffle</option>
        </select>
      </div>

      <div className="adm-card-title">Lineup</div>
      {entries.length === 0 ? <p className="hint">Nothing yet: add films, episodes, whole shows or a genre below.</p> : null}
      {entries.map((e, i) => (
        <div className="adm-row" key={`${e.kind}:${e.ref}:${i}`}>
          <span className="hint" style={{ minWidth: 92 }}>
            {KIND_LABEL[e.kind]}
          </span>
          <span className="adm-grow">{e.label}</span>
          <button type="button" className="secondary" disabled={i === 0} onClick={() => shift(i, -1)}>
            ↑
          </button>
          <button type="button" className="secondary" disabled={i === entries.length - 1} onClick={() => shift(i, 1)}>
            ↓
          </button>
          <button type="button" className="secondary" onClick={() => setEntries((list) => list.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}

      <div className="adm-card-title">Add</div>
      <div className="adm-row">
        <input className="adm-grow" placeholder="Search a film, an episode or a show…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {q.trim() && found
        ? found.entries.slice(0, 20).map((e) => (
            <div className="adm-row" key={`${e.kind}:${e.ref}`}>
              <span className="hint" style={{ minWidth: 92 }}>
                {KIND_LABEL[e.kind]}
              </span>
              <span className="adm-grow">{e.label}</span>
              <button type="button" className="secondary" onClick={() => add(e)}>
                Add
              </button>
            </div>
          ))
        : null}
      <div className="adm-row">
        <select className="adm-grow" value={genre} onChange={(e) => setGenre(e.target.value)} aria-label="Genre">
          <option value="">A genre rule: every film in…</option>
          {(found?.genres ?? []).map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" disabled={!genre} onClick={() => (add({ kind: "genre", ref: genre, label: `Every ${genre} film` }), setGenre(""))}>
          Add rule
        </button>
      </div>

      <div className="adm-row">
        <button type="button" onClick={() => void save()} disabled={saving || !name.trim()}>
          {saving ? "Saving…" : "Save channel"}
        </button>
        <button type="button" className="secondary" onClick={() => void rebuild()} title="Pick up new films for genre rules, reshuffle">
          Rebuild lineup
        </button>
        <span className="adm-grow" />
        <button type="button" className="adm-danger" onClick={() => void remove()}>
          Delete channel
        </button>
      </div>

      {detail.guide.length ? (
        <>
          <div className="adm-card-title">Guide</div>
          {detail.guide.map((g, i) => (
            <div className="adm-row" key={`${g.startsAt}:${i}`}>
              <span className="hint" style={{ minWidth: 92 }}>
                {i === 0 ? "On now" : clock(g.startsAt)}
              </span>
              <span className="adm-grow">{g.name}</span>
              <span className="hint">until {clock(g.endsAt)}</span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
