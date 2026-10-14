"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  auditHead,
  groupsHead,
  linkQuestion,
  oldestReport,
  peopleReport,
  stillsHead,
  stillsLists,
  storeCards,
  tickReport,
  tmdbAge,
  type Audit,
  type Group,
  type PeopleStats,
  type StillsPlan,
  type StoreStats,
} from "@/lib/admin/tmdb-view";

import { useToasts } from "../Toasts";

/**
 * The TMDB tab: what the store holds, filling it a pass at a time, the
 * identification audit, how old entries are, shows and their links, and
 * episodes without TMDB's still. Ported from curator.html's TMDB tab.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Store({ refreshKey }: { refreshKey: number }) {
  const [cards, setCards] = useState<ReturnType<typeof storeCards> | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([
      adminApi<StoreStats>("/api/admin/tmdb").catch(() => ({}) as StoreStats),
      adminApi<PeopleStats>("/api/admin/people").catch(() => ({}) as PeopleStats),
    ]).then(([s, p]) => live && setCards(storeCards(s, p, Date.now())));
    return () => {
      live = false;
    };
  }, [refreshKey]);
  if (!cards) return <p className="hint">Reading…</p>;
  return (
    <div className="adm-health-grid">
      {cards.map((c) => (
        <div key={c.label} className="adm-health-card">
          <div className="adm-hc-label">{c.label}</div>
          <div className="adm-hc-value">{c.value}</div>
          {c.sub ? <div className="adm-hc-sub">{c.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

function AuditCard() {
  const [result, setResult] = useState<Audit | null>(null);
  const [state, setState] = useState<string | null>(null);
  async function run() {
    setState("Comparing every film against TMDB…");
    setResult(null);
    try {
      setResult(await adminApi<Audit>("/api/admin/match-audit"));
      setState(null);
    } catch (e) {
      setState(`Failed: ${message(e)}`);
    }
  }
  return (
    <section className="adm-card">
      <div className="adm-row">
        <div className="adm-grow">
          <h2 className="adm-card-title">Identification audit</h2>
          <p className="hint">
            Every film ranked by how much its identification disagrees with TMDB, using alternative titles. This is what finds the mis-matches
            nobody has tripped over yet — <code>[Rec] 2</code> spent months identified as <i>The Descent: Part 2</i> and was found by eye.
          </p>
        </div>
        <button type="button" className="secondary" onClick={run}>
          Run audit
        </button>
      </div>
      {state ? <p className="hint">{state}</p> : null}
      {result ? (
        <>
          <p className="hint">{auditHead(result)}</p>
          {result.findings.length ? (
            result.findings.map((f, i) => (
              <div key={`${f.filename}:${i}`} className={`adm-finding${f.verdict === "suspect" ? " suspect" : ""}`}>
                <div className="adm-finding-title">
                  {f.libraryTitle ?? ""} <span className="hint">({f.libraryYear ?? "?"})</span>
                  {f.verdict === "suspect" ? <span className="adm-bad adm-finding-tag">SUSPECT</span> : null}
                </div>
                <div className="hint">
                  TMDB: {f.tmdbTitle ?? "—"} ({f.tmdbYear ?? "?"})
                </div>
                <div className="adm-path">{f.filename ?? ""}</div>
                <div>{f.why ?? ""}</div>
              </div>
            ))
          ) : (
            <p className="hint">Nothing disagrees.</p>
          )}
        </>
      ) : null}
    </section>
  );
}

function AgesCard({ onRefreshed }: { onRefreshed: () => void }) {
  const [kind, setKind] = useState("movie");
  const [data, setData] = useState<{ total: number; entries: Array<{ tmdbId: number; title: string | null; ageDays: number; season: number | null }> } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, "busy" | "done" | string>>({});

  const load = useCallback(async (k: string) => {
    setNote("Reading…");
    setData(null);
    try {
      setData(await adminApi(`/api/admin/tmdb/entries?kind=${encodeURIComponent(k)}&limit=40`));
      setNote(null);
    } catch (e) {
      setNote(message(e));
    }
  }, []);

  async function refreshOne(e: { tmdbId: number; season: number | null }) {
    const key = `${e.tmdbId}:${e.season ?? ""}`;
    setDone((d) => ({ ...d, [key]: "busy" }));
    try {
      await adminApi("/api/admin/tmdb/entries", { method: "POST", body: { kind, tmdbId: e.tmdbId, ...(e.season != null ? { season: e.season } : {}) } });
      setDone((d) => ({ ...d, [key]: "done" }));
    } catch (err) {
      setDone((d) => ({ ...d, [key]: message(err) }));
    }
  }

  async function refreshOldest() {
    setNote("Refreshing anything fetched more than 30 days ago…");
    try {
      setNote(oldestReport(await adminApi("/api/admin/tmdb/entries", { method: "POST", body: { oldest: true, maxAgeDays: 30 } })));
      onRefreshed();
    } catch (e) {
      setNote(message(e));
    }
  }

  return (
    <section className="adm-card">
      <div className="adm-row">
        <div className="adm-grow">
          <h2 className="adm-card-title">How old the store is</h2>
          <p className="hint">
            A cached payload is a snapshot. Refresh one when you know it changed upstream (new artwork, a corrected credit), or everything past a
            month at once.
          </p>
        </div>
        <div className="adm-acts">
          <select
            value={kind}
            aria-label="Which kind"
            onChange={(e) => {
              setKind(e.target.value);
              void load(e.target.value);
            }}
          >
            <option value="movie">Films</option>
            <option value="tv">Shows</option>
            <option value="season">Seasons</option>
            <option value="person">People</option>
          </select>
          <button type="button" className="secondary" onClick={() => void load(kind)}>
            Show oldest
          </button>
          <button type="button" className="secondary" onClick={refreshOldest}>
            Refresh anything over 30 days
          </button>
        </div>
      </div>
      {note ? <p className="hint">{note}</p> : null}
      {data ? (
        <>
          <p className="hint">
            {data.total} cached · the {data.entries.length} oldest, oldest first
          </p>
          <div className="adm-rows">
            {data.entries.map((r) => {
              const key = `${r.tmdbId}:${r.season ?? ""}`;
              const st = done[key];
              return (
                <div key={key} className="adm-row">
                  <span className="adm-grow">{r.title || `#${r.tmdbId}`}</span>
                  <span className="hint">{st === "done" ? "today" : tmdbAge(r.ageDays)}</span>
                  <button type="button" className="secondary" disabled={st === "busy" || st === "done"} title={st && st !== "busy" && st !== "done" ? st : undefined} onClick={() => refreshOne(r)}>
                    {st === "busy" ? "Refreshing…" : st === "done" ? "Done" : st ? "Retry" : "Refresh"}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}

function GroupRow({ g }: { g: Group }) {
  const { show } = useToasts();
  const [q, setQ] = useState(g.name);
  const [cands, setCands] = useState<Array<{ id: number; name: string; year: number | null; episodes: number | null; overview: string | null }> | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function search() {
    setNote("Asking TMDB…");
    setCands(null);
    try {
      const d = await adminApi<{ candidates: typeof cands }>("/api/admin/tmdb", { method: "PUT", body: { groupId: g.groupId, search: true, name: q } });
      const list = d.candidates ?? [];
      setCands(list);
      setNote(list.length ? null : "Nothing on TMDB by that name. Try the original-language title.");
    } catch (e) {
      setNote(message(e));
    }
  }

  async function link(c: { id: number; name: string; episodes: number | null }) {
    // Applying stills trusts this link completely, so it asks first, with both counts side by side.
    if (!confirm(linkQuestion(g, c))) return;
    try {
      await adminApi("/api/admin/tmdb", { method: "PUT", body: { groupId: g.groupId, tmdbId: c.id } });
      setCands(null);
      setNote("Linked. Run one pass above to fetch its seasons now. The weekly job applies stills to every linked show, so this link reaches the episodes the next time it runs.");
    } catch (e) {
      show("err", message(e));
    }
  }

  return (
    <div className="adm-row-block">
      <div className="adm-row">
        <div className="adm-grow">
          <b>{g.name}</b>{" "}
          <span className="hint">
            {g.files} {g.files === 1 ? "file" : "files"}
          </span>
          <div className="hint">
            {g.link ? (
              <>
                Linked to {g.link.name || `#${g.link.tmdbId}`} · {g.link.resolvedBy ?? ""}
              </>
            ) : g.kind === "movie" ? (
              "A film in parts — correctly not linked to a show"
            ) : (
              <span className="adm-wait">Not linked</span>
            )}
          </div>
        </div>
        <input
          value={q}
          spellCheck={false}
          aria-label={`Search TMDB for ${g.name}`}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void search();
          }}
        />
        <button type="button" className="secondary" onClick={search}>
          Search TMDB
        </button>
      </div>
      {note ? <p className="hint">{note}</p> : null}
      {cands?.map((c) => (
        <div key={c.id} className="adm-row adm-cand">
          <div className="adm-grow">
            <b>{c.name}</b>{" "}
            <span className="hint">
              ({c.year ?? "?"}) · {c.episodes != null ? `${c.episodes} episodes` : "episode count unknown"}
            </span>
            {c.overview ? <div className="hint">{c.overview}</div> : null}
          </div>
          <button type="button" className="secondary" onClick={() => link(c)}>
            Link
          </button>
        </div>
      ))}
    </div>
  );
}

function GroupsCard() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function load() {
    setNote("Reading…");
    try {
      const d = await adminApi<{ groups: Group[] }>("/api/admin/tmdb/groups");
      setGroups(d.groups ?? []);
      setNote(null);
    } catch (e) {
      setNote(message(e));
    }
  }
  return (
    <section className="adm-card">
      <div className="adm-row">
        <div className="adm-grow">
          <h2 className="adm-card-title">Shows and their links</h2>
          <p className="hint">
            The backfill links a group only on an exact name and a plausible episode count, because a wrong link stamps another show’s stills
            across every episode. Whatever it left alone is listed first. Linking is by hand and asks before it does anything.
          </p>
        </div>
        <button type="button" className="secondary" onClick={load}>
          Load
        </button>
      </div>
      {note ? <p className="hint">{note}</p> : null}
      {groups ? (
        <>
          <p className="hint">{groupsHead(groups)}</p>
          <div className="adm-rows">
            {groups.map((g) => (
              <GroupRow key={g.groupId} g={g} />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function StillsCard() {
  const [plan, setPlan] = useState<StillsPlan | null>(null);
  const [note, setNote] = useState<string | null>(null);
  async function load() {
    setNote("Planning — this touches nothing…");
    try {
      setPlan(await adminApi<StillsPlan>("/api/admin/episode-stills?detail=1"));
      setNote(null);
    } catch (e) {
      setNote(message(e));
    }
  }
  return (
    <section className="adm-card">
      <div className="adm-row">
        <div className="adm-grow">
          <h2 className="adm-card-title">Episodes without TMDB’s still</h2>
          <p className="hint">
            Why each one was skipped, file by file: no episode number in its name, an episode TMDB does not have (usually a special shifting the
            numbering), or an episode TMDB has without a still. A plan only — this touches nothing.
          </p>
        </div>
        <button type="button" className="secondary" onClick={load}>
          Load
        </button>
      </div>
      {note ? <p className="hint">{note}</p> : null}
      {plan ? (
        <>
          <p className="hint">{stillsHead(plan)}</p>
          {stillsLists(plan).map((l) => (
            <div key={l.title} className="adm-stills">
              <b>{l.title}</b> <span className="hint">{l.items.length}</span>
              <p className="hint">{l.why}</p>
              {l.items.map((it) => (
                <div key={it.sub} className="adm-stills-row">
                  <div>{it.main}</div>
                  <div className="adm-path">{it.sub}</div>
                </div>
              ))}
            </div>
          ))}
        </>
      ) : null}
    </section>
  );
}

export function TmdbWorkspace() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bump = () => setRefreshKey((k) => k + 1);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(true);
    setOut(label);
    try {
      setOut(await fn());
      bump();
    } catch (e) {
      setOut(`Failed: ${message(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-health">
      <section className="adm-card">
        <div className="adm-row">
          <div className="adm-grow">
            <h2 className="adm-card-title">The TMDB store</h2>
            <p className="hint">
              Cast, full crew, keywords, stills, logos and recommendations — none of which OMDb carries. Fetched once and kept, so a new use of this
              data costs a SQL read rather than 400 requests over a link that drops one in thirty.
            </p>
          </div>
          <button type="button" className="secondary" onClick={bump}>
            Refresh
          </button>
        </div>
        <Store refreshKey={refreshKey} />
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">Fill the store</h2>
        <p className="hint">
          Bounded and repeatable rather than one long run: TMDB has no daily quota, but the link to it fails often enough that a full pass would
          spend minutes failing. Press again to continue — the store itself is the cursor, so nothing is redone.
        </p>
        <div className="adm-acts">
          <button type="button" disabled={busy} onClick={() => run("Running one pass…", async () => tickReport(await adminApi("/api/admin/tmdb", { method: "POST", body: { budget: 40 } })))}>
            Run one pass
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => run("Rebuilding from what is already cached…", async () => peopleReport(await adminApi("/api/admin/people", { method: "POST" })))}
          >
            Rebuild people &amp; credits
          </button>
          <span className="hint">Rebuilding people reads only what is already cached — no network at all — and is safe to press twice.</span>
        </div>
        {out ? <p className="hint">{out}</p> : null}
      </section>

      <AuditCard />
      <AgesCard onRefreshed={bump} />
      <GroupsCard />
      <StillsCard />
    </div>
  );
}
