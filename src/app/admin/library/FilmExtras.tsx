"use client";

import { useEffect, useId, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { sfKindLabel, sfOptions, sfPick, SF_KINDS } from "@/lib/admin/library-extras";
import type { FeatureGuess, LibraryItem, SpecialFeature } from "@/lib/admin/library-rows";

import { useToasts } from "../Toasts";
import type { LibraryContext } from "./LibraryWorkspace";

/**
 * The film pane's two blocks about what a film belongs to: its franchises,
 * and (for an extra) where it appears as a special feature, plus the extras
 * that appear on this film's own page. Ported from curator.html (fsPaneHtml,
 * sfPaneHtml, sfOnFilmHtml and their actions).
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ---- franchise membership ------------------------------------------ */

interface Membership {
  seriesId: string;
  seriesName: string;
  entryId: string;
  position: number;
}

interface FranchiseOption {
  id: string;
  name: string;
}

// Every franchise there is: the same list for every film, so fetched once per
// visit and dropped whenever one is created.
let allFranchises: Promise<FranchiseOption[]> | null = null;
function loadAllFranchises(): Promise<FranchiseOption[]> {
  allFranchises ??= adminApi<{ series: FranchiseOption[] }>("/api/admin/library/film-series")
    .then((d) => [...(d.series ?? [])].sort((a, b) => a.name.localeCompare(b.name)))
    .catch((e) => {
      allFranchises = null;
      throw e;
    });
  return allFranchises;
}

export function FranchiseBlock({ item, name }: { item: LibraryItem; name: string }) {
  const { show } = useToasts();
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [options, setOptions] = useState<FranchiseOption[]>([]);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const imdbId = item.imdbId ?? null;

  useEffect(() => {
    if (!imdbId) return;
    let live = true;
    setMemberships(null);
    adminApi<{ series: Membership[] }>(`/api/admin/library/film-series/for-film?imdbId=${encodeURIComponent(imdbId)}`)
      .then((d) => live && setMemberships(d.series ?? []))
      .catch(() => live && setMemberships([]));
    loadAllFranchises()
      .then((list) => live && setOptions(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [imdbId]);

  if (!imdbId) {
    return (
      <>
        <h3 className="adm-section">Franchise</h3>
        <p className="hint">Identify this film first — franchise membership is keyed on its IMDb id.</p>
      </>
    );
  }

  async function refresh() {
    const d = await adminApi<{ series: Membership[] }>(`/api/admin/library/film-series/for-film?imdbId=${encodeURIComponent(imdbId!)}`);
    setMemberships(d.series ?? []);
  }

  async function act(key: string, fn: () => Promise<string>) {
    setBusy(key);
    try {
      const text = await fn();
      await refresh();
      show("ok", text);
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  const entry = { title: name, year: item.year ?? null, imdb_id: imdbId };

  return (
    <>
      <h3 className="adm-section">Franchise</h3>
      <div className="adm-sf">
        {memberships === null ? (
          <p className="hint">Checking…</p>
        ) : memberships.length ? (
          <div className="adm-sf-targets">
            {memberships.map((m) => (
              <span key={m.entryId} className="adm-sf-target">
                {m.seriesName} <span className="hint">#{m.position + 1}</span>
                <button
                  type="button"
                  className="secondary adm-sf-x"
                  title="Take it out of this franchise"
                  disabled={busy !== null}
                  onClick={() =>
                    act("remove", async () => {
                      await adminApi(
                        `/api/admin/library/film-series/${encodeURIComponent(m.seriesId)}/entries/${encodeURIComponent(m.entryId)}`,
                        { method: "DELETE" },
                      );
                      return "Removed from that franchise.";
                    })
                  }
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="hint">Not in any franchise.</p>
        )}
        <div className="adm-acts">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add to an existing franchise">
            <option value="">Add to an existing franchise…</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={busy !== null || !pick}
            onClick={() =>
              act("add", async () => {
                await adminApi(`/api/admin/library/film-series/${encodeURIComponent(pick)}/entries`, { method: "POST", body: entry });
                setPick("");
                return "Added.";
              })
            }
          >
            Add
          </button>
        </div>
        <div className="adm-acts">
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            title="Ask TMDB which collection this belongs to and build it"
            onClick={() =>
              act("tmdb", async () => {
                const d = await adminApi<{ ok: boolean; reason?: string; name?: string; entries?: number; matched?: number }>(
                  "/api/admin/library/film-series/for-film",
                  { method: "POST", body: { itemId: item.id } },
                );
                if (!d.ok) throw new Error(d.reason || "TMDB had nothing.");
                allFranchises = null;
                return `${d.name} — ${d.entries} films, ${d.matched} matched to IMDb ids.`;
              })
            }
          >
            {busy === "tmdb" ? "Asking TMDB…" : "Find franchise from TMDB"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy !== null}
            onClick={() => {
              const newName = prompt("Name for this franchise?", name);
              if (!newName || !newName.trim()) return;
              void act("new", async () => {
                const d = await adminApi<{ series: { id: string } }>("/api/admin/library/film-series", {
                  method: "POST",
                  body: { name: newName.trim() },
                });
                await adminApi(`/api/admin/library/film-series/${encodeURIComponent(d.series.id)}/entries`, { method: "POST", body: entry });
                allFranchises = null;
                loadAllFranchises()
                  .then(setOptions)
                  .catch(() => {});
                return "Franchise created.";
              });
            }}
          >
            New franchise from this film
          </button>
        </div>
      </div>
    </>
  );
}

/* ---- special features ---------------------------------------------- */

type Targets = Record<string, Array<{ id: string; label: string }>>;

// Every film, franchise, director and actor: big, the same for every extra,
// fetched the first time a picker is used.
let allTargets: Promise<Targets> | null = null;
function loadTargets(): Promise<Targets> {
  allTargets ??= adminApi<Targets>("/api/admin/special-features/targets").catch((e) => {
    allTargets = null;
    throw e;
  });
  return allTargets;
}

interface OnFilm {
  itemId: string;
  title: string;
  via: Array<{ kind: string; targetId: string; targetLabel: string | null; direct: boolean; scope: string }>;
}

/**
 * For an extra: where it appears, add or remove places, or, for a
 * suggestion, confirm one of the guessed places. For any film: the extras
 * that appear on its own page, and which mapping puts each there (an
 * inherited one, through a director or franchise, says how far removing it
 * reaches).
 */
export function FeatureBlock({
  item,
  name,
  feature,
  guess,
  ctx,
}: {
  item: LibraryItem;
  name: string;
  feature: SpecialFeature | undefined;
  guess: FeatureGuess | undefined;
  ctx: LibraryContext;
}) {
  const { show } = useToasts();
  const [kind, setKind] = useState<string>(SF_KINDS[0].kind);
  const [typed, setTyped] = useState("");
  const [targets, setTargets] = useState<Targets | null>(null);
  const [onFilm, setOnFilm] = useState<OnFilm[] | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  useEffect(() => {
    let live = true;
    setOnFilm(null);
    adminApi<{ features: OnFilm[] }>(`/api/admin/special-features/for-item?itemId=${encodeURIComponent(item.id)}`)
      .then((d) => live && setOnFilm(d.features ?? []))
      .catch(() => live && setOnFilm([]));
    return () => {
      live = false;
    };
    // Any mapping change can alter what appears here, so this re-asks on every change.
  }, [item.id, ctx.features]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const d = await adminApi<{ features: SpecialFeature[] }>("/api/admin/special-features", { method: "POST", body });
      ctx.setFeatures(d.features ?? []);
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  function wantTargets() {
    if (targets) return;
    loadTargets()
      .then(setTargets)
      .catch((e) => show("err", message(e)));
  }

  const options = sfOptions(targets, kind);

  const featureBlock = feature ? (
    <>
      <h3 className="adm-section">Special feature</h3>
      <div className="adm-sf">
        {feature.targets.length ? (
          <>
            <p className="hint">Appears on:</p>
            <div className="adm-sf-targets">
              {feature.targets.map((t) => (
                <span key={`${t.kind}:${t.targetId}`} className="adm-sf-target">
                  <span className="adm-sf-kind">{sfKindLabel(t.kind)}</span> <b>{t.targetLabel || t.targetId}</b>
                  <button
                    type="button"
                    className="secondary adm-sf-x"
                    title="Stop showing it there"
                    disabled={busy}
                    onClick={() => post({ action: "unmap", itemId: item.id, kind: t.kind, targetId: t.targetId })}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </>
        ) : (
          <p className="hint">Hidden from the library, but it does not appear anywhere yet.</p>
        )}
        <div className="adm-acts">
          <select
            value={kind}
            aria-label="Show it on a"
            onChange={(e) => {
              setKind(e.target.value);
              setTyped("");
              wantTargets();
            }}
          >
            {SF_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          {/* A datalist, not a select: the film list is the whole library, and typing three letters beats scrolling six hundred titles. */}
          <input list={listId} value={typed} placeholder="Also show it on…" onFocus={wantTargets} onChange={(e) => setTyped(e.target.value)} />
          <datalist id={listId}>
            {options.map((o) => (
              <option key={o.id} value={o.label} />
            ))}
          </datalist>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              const hit = sfPick(options, typed);
              if (!hit) {
                show("err", "Pick something from the list.");
                return;
              }
              setTyped("");
              void post({ action: "map", itemId: item.id, title: name, kind, targetId: hit.id, targetLabel: hit.label });
            }}
          >
            Add
          </button>
        </div>
      </div>
    </>
  ) : guess ? (
    <>
      <h3 className="adm-section">Special feature?</h3>
      <div className="adm-sf">
        <p className="hint">
          Looks like one — {guess.reasons.join(" · ")} <span className="adm-sf-conf">{guess.confidence}% sure</span>
        </p>
        {guess.targets.length ? (
          <>
            <p className="hint">Show it on:</p>
            <div className="adm-sf-targets">
              {guess.targets.map((t) => (
                <button
                  key={`${t.kind}:${t.targetId}`}
                  type="button"
                  className="secondary"
                  title={t.reason ?? ""}
                  disabled={busy}
                  onClick={() =>
                    post({ action: "map", itemId: item.id, title: name, kind: t.kind, targetId: t.targetId, targetLabel: t.targetLabel })
                  }
                >
                  <span className="adm-sf-kind">{sfKindLabel(t.kind)}</span> {t.targetLabel}
                </button>
              ))}
            </div>
          </>
        ) : null}
        <div className="adm-acts">
          <button type="button" className="secondary" disabled={busy} onClick={() => post({ action: "mark", itemId: item.id, title: name })}>
            Hide it, decide later
          </button>
          {/* Only for this visit: re-running the scan is cheap, and a stored "no" would need its own way to change your mind. */}
          <button type="button" className="secondary" disabled={busy} onClick={() => ctx.dismissGuess(item.id)}>
            Not a special feature
          </button>
        </div>
      </div>
    </>
  ) : null;

  return (
    <>
      {featureBlock}
      {onFilm && onFilm.length ? (
        <>
          <h3 className="adm-section">Special features on this page</h3>
          <div className="adm-sf">
            {onFilm.map((f) => (
              <div key={f.itemId} className="adm-sf-onfilm">
                <div className="adm-sf-name">{f.title}</div>
                <div className="adm-sf-targets">
                  {f.via.map((v) => (
                    <span key={`${v.kind}:${v.targetId}`} className={`adm-sf-target${v.direct ? "" : " inherited"}`}>
                      <span className="adm-sf-kind">{sfKindLabel(v.kind)}</span> <b>{v.targetLabel || v.targetId}</b>
                      <button
                        type="button"
                        className="secondary adm-sf-x"
                        title={`Remove from ${v.scope}`}
                        disabled={busy}
                        onClick={() => {
                          // "Unlink" on a director mapping takes it off every one of that director's films; the scope says so.
                          if (!confirm(`Stop showing this special feature on ${v.scope}?`)) return;
                          void post({ action: "unmap", itemId: f.itemId, kind: v.kind, targetId: v.targetId });
                        }}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * One film's release date (rollout.ts, subject "film"): hidden everywhere
 * until then, and in Coming soon with its date meanwhile. Times are India
 * time; the default is 8 pm.
 */
export function ReleaseDateBlock({ item }: { item: LibraryItem }) {
  const { show } = useToasts();
  const [release, setRelease] = useState<{ releaseAt: number; released: boolean } | null | undefined>(undefined);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("20:00");
  const [busy, setBusy] = useState(false);
  const path = item.path;

  useEffect(() => {
    if (!path) return;
    let live = true;
    setRelease(undefined);
    adminApi<{ release: { releaseAt: number; released: boolean } | null }>(
      `/api/admin/library/film-release?path=${encodeURIComponent(path)}`,
    )
      .then((d) => live && setRelease(d.release))
      .catch(() => live && setRelease(null));
    return () => {
      live = false;
    };
  }, [path]);

  async function save(releaseAt: number | null) {
    setBusy(true);
    try {
      const d = await adminApi<{ release: { releaseAt: number; released: boolean } | null }>("/api/admin/library/film-release", {
        method: "POST",
        body: { path, releaseAt },
      });
      setRelease(d.release);
      show("ok", releaseAt === null ? "Released: it shows on the site now." : "Scheduled. It's hidden until then, and in Coming soon.");
    } catch (e) {
      show("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function schedule() {
    const at = Date.parse(`${date}T${time || "20:00"}:00+05:30`);
    if (!date || !Number.isFinite(at)) {
      show("err", "Pick a date.");
      return;
    }
    void save(at);
  }

  if (!path) {
    return (
      <>
        <h3 className="adm-section">Release date</h3>
        <p className="hint">This item has no file, so it can't be scheduled.</p>
      </>
    );
  }

  const pending = release && !release.released && release.releaseAt > Date.now();
  return (
    <>
      <h3 className="adm-section">Release date</h3>
      {release === undefined ? (
        <p className="hint">Loading…</p>
      ) : pending ? (
        <div className="adm-row">
          <span className="adm-grow">
            Hidden until{" "}
            <b>
              {new Date(release.releaseAt).toLocaleString("en-GB", {
                timeZone: "Asia/Kolkata",
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
            </b>
            , and in Coming soon meanwhile.
          </span>
          <button type="button" className="secondary" disabled={busy} onClick={() => void save(null)}>
            Release now
          </button>
        </div>
      ) : (
        <p className="hint">Shown on the site. Pick a date to hide it until then and list it in Coming soon.</p>
      )}
      <div className="adm-row">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <button type="button" disabled={busy || !date} onClick={schedule}>
          {pending ? "Move it" : "Schedule"}
        </button>
      </div>
    </>
  );
}

