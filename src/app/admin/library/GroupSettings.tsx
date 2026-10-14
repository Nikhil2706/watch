"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { fetchAllReport, gapsLabel, memberTitle, seasonGaps, seriesLinkedReport, type GroupMember } from "@/lib/admin/library-extras";
import { shortPath, type LibraryItem } from "@/lib/admin/library-rows";

import { useToasts } from "../Toasts";
import { IdentifyPanel, ManualPanel } from "./ItemPanels";
import { RolloutPanel } from "./RolloutPanel";

/**
 * A show's settings: name, synopsis, the real series' IMDb link, whether it
 * counts episodes or parts, its release schedule, and its episodes — each
 * with OMDb fetch, Identify, Type it in, Hide and Remove. Ported from
 * curator.html (toggleGroupManage, renderGroupManage and their actions).
 */

interface GroupDetail {
  groupId: string;
  groupName: string;
  overview: string | null;
  seriesImdbId: string | null;
  kind: "series" | "movie" | null;
  items: Array<GroupMember & { year: number | null }>;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function GroupSettings({ groupId, onChanged }: { groupId: string; onChanged: () => void }) {
  const { show } = useToasts();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [overview, setOverview] = useState("");
  const [series, setSeries] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [fetched, setFetched] = useState<Record<string, string>>({});
  const [panel, setPanel] = useState<{ id: string; kind: "identify" | "manual" } | null>(null);
  const [fetchingAll, setFetchingAll] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<GroupDetail>(`/api/admin/library/group-detail?groupId=${encodeURIComponent(groupId)}`);
      setDetail(d);
      setName(d.groupName);
      setOverview(d.overview ?? "");
      setSeries(d.seriesImdbId ?? "");
      setKind(d.kind ?? "");
    } catch (e) {
      setError(message(e));
    }
  }, [groupId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  const saveName = () =>
    run("name", async () => {
      if (!name.trim()) throw new Error("Name can't be empty.");
      await adminApi("/api/admin/library/group-rename", { method: "POST", body: { groupId, name: name.trim() } });
      show("ok", `Renamed to “${name.trim()}”.`);
      onChanged();
    });
  const saveOverview = () =>
    run("overview", async () => {
      await adminApi("/api/admin/library/group-overview", { method: "POST", body: { groupId, overview: overview.trim() } });
      show("ok", "Synopsis saved.");
    });
  const saveSeries = () =>
    run("series", async () => {
      if (!series.trim()) throw new Error("Paste the series' IMDb link or id.");
      const d = await adminApi<{ seriesName?: string; posterFound?: boolean; kind?: string }>("/api/admin/library/group-series", {
        method: "POST",
        body: { groupId, providerLink: series.trim() },
      });
      show("ok", seriesLinkedReport(d));
      await load();
    });
  const saveKind = () =>
    run("kind", async () => {
      if (!kind) throw new Error('Pick "TV series" or "Film in parts".');
      await adminApi("/api/admin/library/group-kind", { method: "POST", body: { groupId, kind } });
      show("ok", kind === "series" ? "Now counted in episodes." : "Now counted in parts.");
    });

  async function fetchEpisode(it: GroupMember): Promise<boolean> {
    try {
      const r = await adminApi<{ name: string; posterSet?: boolean }>("/api/admin/library/episode-fetch", {
        method: "POST",
        body: { itemId: it.id, groupId, season: it.season || 1, episode: it.episode, path: it.path },
      });
      setFetched((f) => ({ ...f, [it.id]: r.name }));
      return true;
    } catch (e) {
      show("err", `${it.name}: ${message(e)}`);
      return false;
    }
  }

  async function fetchOne(it: GroupMember) {
    setBusy(`ep:${it.id}`);
    const ok = await fetchEpisode(it);
    setBusy(null);
    if (ok) onChanged();
  }

  async function fetchAll() {
    if (!detail) return;
    const todo = detail.items.filter((it) => it.episode !== null && !fetched[it.id]);
    if (!todo.length) {
      show("err", "Nothing left to fetch.");
      return;
    }
    // One at a time: OMDb is a shared free-tier key. One refresh at the end.
    setFetchingAll(todo.length);
    let ok = 0;
    let failed = 0;
    for (const it of todo) {
      if (await fetchEpisode(it)) ok++;
      else failed++;
    }
    setFetchingAll(null);
    show(failed ? "err" : "ok", fetchAllReport(ok, failed));
    onChanged();
  }

  async function hide(it: GroupMember) {
    await run(`hide:${it.id}`, async () => {
      await adminApi("/api/admin/library/exclude", { method: "POST", body: { path: it.path } });
      show("ok", `Hidden from the site — ${it.name}.`);
      onChanged();
      await load();
    });
  }

  async function remove(it: GroupMember) {
    if (!confirm(`Remove "${it.label || it.name}" from this group? It goes back to showing on its own on Browse.`)) return;
    await run(`remove:${it.id}`, async () => {
      await adminApi("/api/admin/library/remove-from-group", { method: "POST", body: { path: it.path } });
      show("ok", "Removed from group.");
      onChanged();
      await load();
    });
  }

  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="hint">Loading…</p>;
  const gaps = seasonGaps(detail.items);
  const n = detail.items.length;

  return (
    <div className="adm-card adm-panel adm-group-settings">
      <div className="adm-row adm-row-end">
        <label>
          Group name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" disabled={busy === "name"} onClick={saveName}>
          Save name
        </button>
      </div>
      <div className="adm-row adm-row-end">
        <label>
          Synopsis (shown on the collection page)
          <input value={overview} placeholder="A line or two about it" onChange={(e) => setOverview(e.target.value)} />
        </label>
        <button type="button" disabled={busy === "overview"} onClick={saveOverview}>
          Save synopsis
        </button>
      </div>
      <div className="adm-row adm-row-end">
        <label>
          Series IMDb link (also fetches the real poster)
          <input value={series} placeholder="https://www.imdb.com/title/tt.../" onChange={(e) => setSeries(e.target.value)} />
        </label>
        <button type="button" disabled={busy === "series"} onClick={saveSeries}>
          Save series
        </button>
      </div>
      <div className="adm-row adm-row-end">
        <label>
          Counts as
          <span className="hint adm-block">
            Decides whether tiles say “{n} episodes” or “{n} parts”. Set from OMDb when you link the series — override it here when OMDb
            calls a long film a mini-series.
          </span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Not set — reads as parts</option>
            <option value="series">TV series — episodes</option>
            <option value="movie">Film in parts — parts</option>
          </select>
        </label>
        <button type="button" disabled={busy === "kind"} onClick={saveKind}>
          Save
        </button>
      </div>

      <RolloutPanel subjectType="group" subjectId={groupId} totalLabel="Total episodes expected" />

      <div className="adm-acts">
        <strong>Episodes ({n})</strong>
        <button type="button" className="secondary" disabled={fetchingAll !== null} onClick={fetchAll}>
          {fetchingAll !== null ? `Fetching ${fetchingAll}…` : "Fetch all from OMDb"}
        </button>
      </div>
      <div className="adm-list-box">
        {gaps.length ? (
          <div className="adm-ep adm-gap">
            <span className="adm-ep-n">missing</span>
            <span className="adm-ep-t">{gapsLabel(gaps)} — not in the library</span>
          </div>
        ) : null}
        {detail.items.map((it) => {
          const t = memberTitle(it);
          const asItem = { ...it, year: it.year ?? null } as unknown as LibraryItem;
          return (
            <div key={it.id} className="adm-ep-block">
              <div className="adm-ep">
                <span className="adm-ep-t">
                  {t.primary}
                  {t.taggedAs ? <span className="hint adm-block">Currently tagged as: {t.taggedAs}</span> : null}
                  <span className="hint adm-block">{shortPath(it.path)}</span>
                  {fetched[it.id] ? <span className="adm-done adm-block">✓ OMDb: {fetched[it.id]}</span> : null}
                </span>
              </div>
              <div className="adm-acts adm-ep-acts">
                {it.episode !== null ? (
                  <button type="button" className="secondary" disabled={busy === `ep:${it.id}` || Boolean(fetched[it.id]) || fetchingAll !== null} onClick={() => fetchOne(it)}>
                    {busy === `ep:${it.id}` ? "Fetching…" : "Fetch OMDb"}
                  </button>
                ) : null}
                <button type="button" className="secondary" onClick={() => setPanel(panel?.id === it.id && panel.kind === "identify" ? null : { id: it.id, kind: "identify" })}>
                  Search
                </button>
                <button type="button" className="secondary" onClick={() => setPanel(panel?.id === it.id && panel.kind === "manual" ? null : { id: it.id, kind: "manual" })}>
                  Manual
                </button>
                <button type="button" className="adm-danger" disabled={busy === `hide:${it.id}`} onClick={() => hide(it)}>
                  Exclude
                </button>
                <button type="button" className="secondary" disabled={busy === `remove:${it.id}`} onClick={() => remove(it)}>
                  Remove
                </button>
              </div>
              {panel?.id === it.id && panel.kind === "identify" ? (
                <IdentifyPanel
                  item={asItem}
                  onDone={(m) => {
                    show("ok", m);
                    setPanel(null);
                    onChanged();
                    void load();
                  }}
                  onClose={() => setPanel(null)}
                />
              ) : null}
              {panel?.id === it.id && panel.kind === "manual" ? (
                <ManualPanel
                  item={asItem}
                  onDone={(m) => {
                    show("ok", m);
                    setPanel(null);
                    onChanged();
                    void load();
                  }}
                  onClose={() => setPanel(null)}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
