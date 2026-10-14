"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  folderMatchFile,
  folderMatchHeading,
  folderMatchRunReport,
  franchiseStatus,
  kindBackfillReport,
  syncAllRounds,
  syncReport,
  type FilmSeriesSummary,
  type FolderMatch,
  type SyncRound,
} from "@/lib/admin/library-extras";

import { useToasts } from "../Toasts";
import { GroupSettings } from "./GroupSettings";
import { RolloutPanel } from "./RolloutPanel";

/**
 * The Library tab's other two views and the folder-match panel. Ported from
 * curator.html: Franchises (renderFilmSeriesList, the TMDB sync and each
 * franchise's entries and release schedule), History (renderCuration: every
 * exclude, group and whitelist, each undoable) and "Match from folders"
 * (fmRender and its actions).
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortName(path: string): string {
  return path.split("/").pop() ?? path;
}

/* ---- Franchises ----------------------------------------------------- */

interface SeriesDetail {
  seriesId: string;
  entries: Array<{ position: number; raw_title: string; raw_year: number | null; imdb_id: string | null; owned: boolean }>;
}

function FranchiseDetail({ seriesId }: { seriesId: string }) {
  const [detail, setDetail] = useState<SeriesDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminApi<SeriesDetail>(`/api/admin/library/film-series/${encodeURIComponent(seriesId)}`)
      .then(setDetail)
      .catch((e) => setError(message(e)));
  }, [seriesId]);
  if (error) return <div className="error">{error}</div>;
  if (!detail) return <p className="hint">Loading…</p>;
  return (
    <div className="adm-manage">
      <RolloutPanel subjectType="series" subjectId={detail.seriesId} totalLabel="Total films expected" />
      <h4 className="adm-sub-head">Entries ({detail.entries.length})</h4>
      <div className="adm-list-box">
        {detail.entries.map((e) => (
          <div key={`${e.position}:${e.raw_title}`} className="adm-ep">
            <span className="adm-ep-n">#{e.position}</span>
            <span className="adm-ep-t">
              {e.raw_title}
              {e.raw_year ? ` (${e.raw_year})` : ""}{" "}
              <span className="hint">
                {e.imdb_id ?? "no IMDb match"} — {e.owned ? "owned" : "not in your library"}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FranchisesView() {
  const { show } = useToasts();
  const [series, setSeries] = useState<FilmSeriesSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ series: FilmSeriesSummary[] }>("/api/admin/library/film-series");
      setSeries(d.series ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    setSyncing(true);
    try {
      // A budget of TMDB calls per request: repeated while TMDB says there is more.
      const total = await syncAllRounds(() => adminApi<SyncRound>("/api/admin/library/film-series/sync-tmdb", { method: "POST", body: {} }));
      show("ok", syncReport(total));
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section>
      <div className="adm-tools">
        <p className="hint adm-grow">
          Franchises your library has at least one film of, from TMDB — incomplete ones first. Open one to see what’s missing or set a release
          schedule.
        </p>
        <button type="button" className="secondary" disabled={syncing} onClick={sync}>
          {syncing ? "Syncing…" : "Sync from TMDB"}
        </button>
      </div>
      {series === null ? (
        <p className="hint">Loading…</p>
      ) : !series.length ? (
        <p className="hint">No franchises yet — “Sync from TMDB” builds them from the films TMDB has linked.</p>
      ) : (
        <div className="adm-rows">
          {series.map((s) => (
            <div key={s.id} className="adm-row-block">
              <div className="adm-row">
                <div className="adm-grow">
                  <strong>{s.name}</strong>
                  <div className="hint">{franchiseStatus(s)}</div>
                </div>
                <button type="button" className="secondary" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                  {open === s.id ? "Close" : "Manage"}
                </button>
              </div>
              {open === s.id ? <FranchiseDetail seriesId={s.id} /> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---- History -------------------------------------------------------- */

interface Curation {
  excluded: Array<{ path: string }>;
  groups: Array<{ groupId: string; groupName: string; paths: string[] }>;
  whitelisted: Array<{ path: string }>;
}

export function HistoryView({ onChanged }: { onChanged: () => void }) {
  const { show } = useToasts();
  const [data, setData] = useState<Curation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [manage, setManage] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminApi<Curation>("/api/admin/library/curation"));
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, url: string, body: Record<string, unknown>, done: string) {
    setBusy(key);
    try {
      await adminApi(url, { method: "POST", body });
      show("ok", done);
      await load();
      onChanged();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  async function resolveKinds() {
    setResolving(true);
    try {
      show("ok", kindBackfillReport(await adminApi("/api/admin/library/group-kind/backfill", { method: "POST" })));
    } catch (e) {
      show("err", message(e));
    } finally {
      setResolving(false);
    }
  }

  return (
    <section>
      <div className="adm-tools">
        <p className="hint adm-grow">
          Every exclude, group and whitelist made here. Nothing here ever touches the files on the drive — undo anything and it is back on the
          site immediately.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={resolving}
          title="Ask OMDb whether each linked show is a TV series or a film in parts"
          onClick={resolveKinds}
        >
          {resolving ? "Asking OMDb…" : "Resolve episodes/parts"}
        </button>
      </div>
      {!data ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          <h3 className="adm-section">Excluded ({data.excluded.length})</h3>
          {data.excluded.length ? (
            <div className="adm-rows">
              {data.excluded.map((e) => (
                <div key={e.path} className="adm-row">
                  <div className="adm-grow">
                    {shortName(e.path)}
                    <div className="adm-path">{e.path}</div>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() => act(`x:${e.path}`, "/api/admin/library/unexclude", { path: e.path }, "Restored to the site.")}
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">Nothing excluded.</p>
          )}

          <h3 className="adm-section">Groups ({data.groups.length})</h3>
          {data.groups.length ? (
            <div className="adm-rows">
              {data.groups.map((g) => (
                <div key={g.groupId} className="adm-row-block">
                  <div className="adm-row">
                    <div className="adm-grow">
                      {g.groupName}
                      <div className="hint">{g.paths.length} parts</div>
                    </div>
                    <button type="button" className="secondary" aria-expanded={manage === g.groupId} onClick={() => setManage(manage === g.groupId ? null : g.groupId)}>
                      {manage === g.groupId ? "Close" : "Manage"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() => {
                        if (!confirm("Dissolve this group? Its parts go back to showing individually on Browse.")) return;
                        void act(`g:${g.groupId}`, "/api/admin/library/ungroup", { groupId: g.groupId }, "Group dissolved.");
                      }}
                    >
                      Dissolve
                    </button>
                  </div>
                  {manage === g.groupId ? <GroupSettings groupId={g.groupId} onChanged={onChanged} /> : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">Nothing grouped.</p>
          )}

          <h3 className="adm-section">Whitelisted ({data.whitelisted.length})</h3>
          {data.whitelisted.length ? (
            <div className="adm-rows">
              {data.whitelisted.map((w) => (
                <div key={w.path} className="adm-row">
                  <div className="adm-grow">
                    {shortName(w.path)}
                    <div className="adm-path">{w.path}</div>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      act(`w:${w.path}`, "/api/admin/library/unwhitelist", { path: w.path }, "Hidden again until it has fetched metadata.")
                    }
                  >
                    Undo
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">Nothing whitelisted.</p>
          )}
        </>
      )}
    </section>
  );
}

/* ---- Match from folders --------------------------------------------- */

export interface FolderMatchesHandle {
  /** Reads the folders for every unidentified file. Quiet: only says something when it found something. */
  run: (quiet: boolean) => Promise<void>;
}

/**
 * What a file's folders say it is. A file called Amblin in the Steven
 * Spielberg folder is his short film, whatever a title search makes of the
 * bare word. Certain matches are applied by the site; the rest are listed
 * here with the reason, for a yes or a no (a no is remembered).
 */
export const FolderMatches = forwardRef<FolderMatchesHandle, { onApplied: () => void; onBusy: (busy: boolean) => void }>(
  function FolderMatches({ onApplied, onBusy }, ref) {
    const { show } = useToasts();
    const [open, setOpen] = useState<FolderMatch[]>([]);
    const [applied, setApplied] = useState<FolderMatch[]>([]);
    const [showApplied, setShowApplied] = useState(false);
    const [pending, setPending] = useState<Record<string, string>>({});

    const take = (d: { open?: FolderMatch[]; applied?: FolderMatch[] } | null) => {
      setOpen(d?.open ?? []);
      setApplied(d?.applied ?? []);
    };

    useEffect(() => {
      // Quiet when it fails: the panel just stays shut.
      adminApi<{ open: FolderMatch[]; applied: FolderMatch[] }>("/api/admin/library/folder-match")
        .then(take)
        .catch(() => {});
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        run: async (quiet: boolean) => {
          onBusy(true);
          try {
            const d = await adminApi<{
              open: FolderMatch[];
              applied: FolderMatch[];
              run?: { looked?: number; applied?: number; suggested?: number; failed?: number };
            }>("/api/admin/library/folder-match", { method: "POST", body: { action: "run" } });
            take(d);
            const r = d.run ?? {};
            if (r.applied || r.suggested || !quiet) show("ok", folderMatchRunReport(r));
            if (r.applied) {
              setShowApplied(true);
              onApplied();
            }
          } catch (e) {
            show("err", message(e));
          } finally {
            onBusy(false);
          }
        },
      }),
      [onApplied, onBusy, show],
    );

    async function decide(act: "accept" | "dismiss", m: FolderMatch) {
      setPending((p) => ({ ...p, [m.path]: act === "accept" ? "Applying…" : "…" }));
      try {
        await adminApi("/api/admin/library/folder-match", { method: "POST", body: { action: act, path: m.path } });
        setOpen((list) => list.filter((x) => x.path !== m.path));
        if (act === "accept") {
          show("ok", `Matched “${m.title}”.`);
          onApplied();
        }
      } catch (e) {
        show("err", message(e));
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[m.path];
          return next;
        });
      }
    }

    if (!open.length && !(showApplied && applied.length)) return null;
    return (
      <section className="adm-matches">
        <div className="adm-row">
          <strong className="adm-grow">{folderMatchHeading(open.length, applied.length)}</strong>
          {applied.length ? (
            <button type="button" className="secondary" onClick={() => setShowApplied((s) => !s)}>
              {showApplied ? "Hide" : "Show"} the {applied.length} matched without asking
            </button>
          ) : null}
        </div>
        {open.map((m) => (
          <div key={m.path} className="adm-match">
            {m.posterPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/tmdb-image?path=${encodeURIComponent(m.posterPath)}&size=w185`} alt="" />
            ) : (
              <span className="adm-match-noimg" />
            )}
            <div className="adm-grow">
              <div>
                <b>{m.title}</b>
                {m.year ? ` (${m.year})` : ""}{" "}
                {m.status === "failed" ? (
                  <span className="adm-warn">could not apply</span>
                ) : m.certainty === "certain" ? (
                  <span className="adm-ok">certain</span>
                ) : null}
              </div>
              <div className="adm-path">{folderMatchFile(m.path)}</div>
              <div className="hint">{m.why}</div>
            </div>
            <div className="adm-acts">
              {pending[m.path] ? (
                <span className="hint">{pending[m.path]}</span>
              ) : (
                <>
                  <button type="button" onClick={() => decide("accept", m)}>
                    Yes, that’s it
                  </button>
                  <button type="button" className="secondary" onClick={() => decide("dismiss", m)}>
                    No
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {showApplied ? (
          <>
            {applied.map((m) => (
              <div key={m.path} className="adm-match">
                <div className="adm-grow">
                  <b>{m.title}</b>
                  {m.year ? ` (${m.year})` : ""}
                  <div className="adm-path">{folderMatchFile(m.path)}</div>
                  <div className="hint">{m.why}</div>
                </div>
              </div>
            ))}
            <p className="hint">Any of these that is wrong can be put right with Identify on the film.</p>
          </>
        ) : null}
      </section>
    );
  },
);
