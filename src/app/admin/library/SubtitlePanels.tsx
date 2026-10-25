"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { episodeCode, type LibraryItem } from "@/lib/admin/library-rows";
import { orderUploadFiles, uploadKind } from "@/lib/subtitle-parts";

import { useToasts } from "../Toasts";

/**
 * Subtitles in the Library tab:
 *  - SubtitleChooser: a film's or episode's candidates, best guess first, each
 *    with why (subtitle-choices.ts); pick one to download. For an episode,
 *    then "match the rest of the show to this".
 *  - SeriesSubtitlePlan: "Find matching subtitles" for a show, from the show
 *    pane, or from an episode the curator has just chosen a subtitle for.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ *
 * One film or episode: choose a subtitle
 * ------------------------------------------------------------------ */

interface Choice {
  candidate: {
    fileId: number;
    release: string | null;
    fileName: string | null;
    uploader: string | null;
    hashMatch: boolean;
  };
  tags: string[];
}

interface Choices {
  title: string;
  path: string;
  existingFiles: string[];
  builtIn: number;
  show: { groupId: string; name: string } | null;
  candidates: Choice[];
}

/** How many candidates show before "Show all". */
const FIRST_FEW = 12;

export function SubtitleChooser({ item, onClose, onAdded }: { item: LibraryItem; onClose: () => void; onAdded: () => void }) {
  const { show } = useToasts();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [added, setAdded] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [matchShow, setMatchShow] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setChoices(await adminApi<Choices>(`/api/admin/subtitles/choices?itemId=${encodeURIComponent(item.id)}`));
    } catch (e) {
      setError(message(e));
    }
  }, [item.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(c: Choice) {
    setBusy(c.candidate.fileId);
    try {
      const r = await adminApi<{ fileName: string; downloadsLeft: number }>("/api/admin/subtitles/choices", {
        method: "POST",
        body: { itemId: item.id, fileId: c.candidate.fileId },
      });
      setAdded((a) => [...a, r.fileName]);
      show("ok", `Added ${r.fileName} (${r.downloadsLeft} downloads left today).`);
      onAdded();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  const has = (choices?.existingFiles.length ?? 0) + added.length + (choices?.builtIn ?? 0);
  const list = choices ? (all ? choices.candidates : choices.candidates.slice(0, FIRST_FEW)) : [];

  return (
    <div className="adm-panel">
      <div className="adm-row">
        <h3 className="adm-section adm-grow">Subtitles</h3>
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {!choices && !error ? <p className="hint">Searching OpenSubtitles (this doesn&apos;t use a download)…</p> : null}
      {choices ? (
        <>
          <p className="hint">
            {choices.existingFiles.length || added.length
              ? `Already has: ${[...choices.existingFiles, ...added].join(", ")}. `
              : choices.builtIn
                ? `Already has ${choices.builtIn} built-in subtitle track${choices.builtIn === 1 ? "" : "s"}. `
                : "No subtitles yet. "}
            Best guess first: synced to this exact file, then made for the same release as the file name, then trusted, rated and
            downloaded most. <b>Try it</b> plays one over the film so you can see it fits (and nudge it) before keeping it.
            A new one is added beside any already there.
          </p>
          {[...choices.existingFiles, ...added].some((f) => f.toLowerCase().endsWith(".srt")) ? (
            <p className="hint">
              Off by a second or two? Sync one by eye:{" "}
              {[...choices.existingFiles, ...added]
                .filter((f) => f.toLowerCase().endsWith(".srt"))
                .map((f, i) => (
                  <span key={f}>
                    {i ? " · " : ""}
                    <a href={`/admin/subtitles/sync?itemId=${encodeURIComponent(item.id)}&name=${encodeURIComponent(f)}`}>Sync {f}</a>
                  </span>
                ))}
            </p>
          ) : null}
          {!choices.candidates.length ? <p className="hint">OpenSubtitles has no English subtitles for this.</p> : null}
          <div className="adm-list-box">
            {list.map((c, i) => (
              <div key={c.candidate.fileId} className="adm-ep">
                <span className="adm-ep-n">{i === 0 ? <b className="adm-best">Best guess</b> : `${i + 1}.`}</span>
                <span className="adm-ep-t">
                  {c.candidate.release || c.candidate.fileName || "subtitle"}
                  <span className="hint">
                    {" "}
                    · {c.candidate.uploader || "unknown uploader"} · {c.tags.join(" · ")}
                  </span>
                </span>
                <a
                  className={i === 0 ? "btn" : "btn ghost"}
                  href={`/admin/subtitles/sync?itemId=${encodeURIComponent(item.id)}&fileId=${c.candidate.fileId}`}
                  title="Play it over the film before keeping it (uses one download, the first time)"
                >
                  Try it
                </a>
                <button type="button" className="secondary" disabled={busy !== null} onClick={() => void download(c)}>
                  {busy === c.candidate.fileId ? "Downloading…" : "Download"}
                </button>
              </div>
            ))}
          </div>
          {choices.candidates.length > FIRST_FEW && !all ? (
            <button type="button" className="secondary" onClick={() => setAll(true)}>
              Show all {choices.candidates.length}
            </button>
          ) : null}
          {choices.show && has > 0 ? (
            <div className="adm-plan">
              <p className="hint">
                Happy with this episode&apos;s subtitle? The rest of <b>{choices.show.name}</b> can be matched to it: the same
                uploader&apos;s files for every episode that has none.
              </p>
              {!matchShow ? (
                <button type="button" onClick={() => setMatchShow(true)}>
                  Match the rest of {choices.show.name} to this
                </button>
              ) : (
                <SeriesSubtitlePlan groupId={choices.show.groupId} referencePath={choices.path} autoStart />
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A show: find matching subtitles for every episode without
 * ------------------------------------------------------------------ */

interface SubsPlan {
  groupId: string;
  headline: string;
  reference: { kind: string; season: number | null; episode: number | null; source: string | null; note: string };
  episodes: Array<{
    path: string;
    season: number;
    episode: number;
    status: string;
    note?: string;
    pick?: { fileId: number; release: string | null; fileName: string | null; uploader: string | null; methodLabel: string; why: string[] };
  }>;
  downloadsUsed: number;
  downloadsLeft: number | null;
}

export function SeriesSubtitlePlan({
  groupId,
  referencePath = null,
  autoStart = false,
}: {
  groupId: string;
  /** Learn from this episode, instead of the plan's own choice of reference. */
  referencePath?: string | null;
  autoStart?: boolean;
}) {
  const { show } = useToasts();
  const [plan, setPlan] = useState<SubsPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [ticked, setTicked] = useState<Record<number, boolean>>({});
  const [applying, setApplying] = useState<"idle" | "busy" | "done">("idle");
  const [failures, setFailures] = useState<Array<{ path: string; message: string }>>([]);

  const findSubs = useCallback(async () => {
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    try {
      const r = await adminApi<{ plan: SubsPlan }>("/api/admin/subtitles/series/plan", {
        method: "POST",
        body: { groupId, referencePath },
      });
      setPlan(r.plan);
      setTicked(Object.fromEntries(r.plan.episodes.map((e, i) => [i, e.status === "planned"])));
      setApplying("idle");
      setFailures([]);
    } catch (e) {
      setPlanError(message(e));
    } finally {
      setPlanning(false);
    }
  }, [groupId, referencePath]);

  useEffect(() => {
    if (autoStart) void findSubs();
  }, [autoStart, findSubs]);

  async function applySubs() {
    if (!plan) return;
    const picks = plan.episodes
      .map((e, i) => (ticked[i] && e.pick ? { path: e.path, fileId: e.pick.fileId } : null))
      .filter((p): p is { path: string; fileId: number } => p !== null);
    if (!picks.length) {
      show("err", "Tick at least one episode.");
      return;
    }
    setApplying("busy");
    try {
      const r = await adminApi<{ results: Array<{ path: string; ok: boolean; message: string }>; downloadsLeft: number | null }>(
        "/api/admin/subtitles/series/apply",
        { method: "POST", body: { groupId, picks } },
      );
      const ok = r.results.filter((x) => x.ok).length;
      show(
        ok === r.results.length ? "ok" : "err",
        `Added ${ok} of ${r.results.length} subtitles${r.downloadsLeft != null ? ` — ${r.downloadsLeft} downloads left today.` : "."}`,
      );
      setFailures(r.results.filter((x) => !x.ok));
      setApplying("done");
    } catch (e) {
      show("err", message(e));
      setApplying("idle");
    }
  }

  const planned = plan ? plan.episodes.filter((e) => e.status === "planned").length : 0;
  const ref = plan?.reference;

  return (
    <>
      {!autoStart ? (
        <div className="adm-acts">
          <button type="button" disabled={planning} onClick={() => void findSubs()}>
            Find matching subtitles
          </button>
        </div>
      ) : null}
      {planning ? <p className="hint">Searching OpenSubtitles for each episode without subtitles — about a second each…</p> : null}
      {planError ? <div className="error">{planError}</div> : null}
      {plan && ref ? (
        <div className="adm-plan">
          <p className="adm-note">
            <b>{plan.headline}</b>
            <br />
            {ref.kind === "external" ? (
              <>
                Learned from the subtitle file next to <b>{episodeCode({ season: ref.season ?? 0, episode: ref.episode ?? 0 })}</b> ({ref.source}).{" "}
              </>
            ) : ref.kind === "embedded" ? (
              <>
                Learned from <b>{episodeCode({ season: ref.season ?? 0, episode: ref.episode ?? 0 })}</b>’s {ref.source}.{" "}
              </>
            ) : null}
            {ref.note}
            {plan.downloadsUsed
              ? ` Identifying it used ${plan.downloadsUsed} download${plan.downloadsUsed === 1 ? "" : "s"}${plan.downloadsLeft != null ? ` (${plan.downloadsLeft} left today)` : ""}.`
              : ""}
          </p>
          {plan.episodes.length ? (
            <div className="adm-list-box">
              {plan.episodes.map((e, i) => (
                <div key={e.path} className="adm-ep">
                  <span className="adm-ep-n">{episodeCode(e)}</span>
                  <span className="adm-ep-t">
                    {e.status === "planned" && e.pick ? (
                      <label className="adm-check">
                        <input type="checkbox" checked={Boolean(ticked[i])} onChange={(ev) => setTicked({ ...ticked, [i]: ev.target.checked })} />
                        <span>
                          {e.pick.release || e.pick.fileName || "subtitle"}{" "}
                          <span className="hint">
                            · <b>{e.pick.methodLabel}</b> · {e.pick.uploader || "unknown uploader"}
                            {e.pick.why.length ? ` · ${e.pick.why.join(", ")}` : ""}
                          </span>
                        </span>
                      </label>
                    ) : (
                      <>
                        <span className="adm-warn">{e.status === "error" ? "search failed" : "no match"}</span>{" "}
                        <span className="hint">{e.note ?? ""}</span>
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {planned ? (
            <div className="adm-acts">
              <button type="button" disabled={applying !== "idle"} onClick={() => void applySubs()}>
                {applying === "busy" ? `Downloading ${Object.values(ticked).filter(Boolean).length}…` : applying === "done" ? "Done" : "Download ticked subtitles"}
              </button>
              <span className="hint">{planned} planned · one download each</span>
            </div>
          ) : null}
          {failures.length ? (
            <p className="adm-note">
              {failures.map((f) => (
                <span key={f.path}>
                  {f.path.split("/").pop()}: {f.message}
                  <br />
                </span>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * A show's pane: the per-episode plan, or for a film kept in parts,
 * the whole film's subtitles cut across its parts
 * ------------------------------------------------------------------ */

export function GroupSubtitles({ groupId }: { groupId: string }) {
  const [filmInParts, setFilmInParts] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    adminApi<{ filmInParts: boolean }>(`/api/admin/subtitles/parts?groupId=${encodeURIComponent(groupId)}&peek=1`)
      .then((r) => live && setFilmInParts(r.filmInParts))
      .catch(() => live && setFilmInParts(false));
    return () => {
      live = false;
    };
  }, [groupId]);

  if (filmInParts === null) return null;
  if (filmInParts) return <FilmPartsSubtitles groupId={groupId} />;
  return (
    <>
      <h3 className="adm-section">Subtitles for every episode</h3>
      <p className="hint">
        Finds a subtitle for each episode that has none — built-in or file. If one episode has a subtitle file (or, failing that, a
        built-in track), it works out which OpenSubtitles upload that is and picks the same uploader’s files; otherwise the one synced to
        each video, else the best-rated. You see every pick before anything is downloaded. To choose which episode it learns from,
        open that episode, pick its subtitle under Subtitles, then “Match the rest of the show to this”.
      </p>
      <SeriesSubtitlePlan groupId={groupId} />
    </>
  );
}

interface PartsChoices {
  parts: Array<{ itemId: string; path: string; label: string; durationMs: number }>;
  candidates: Array<Choice & { candidate: Choice["candidate"] & { files?: Array<{ fileId: number; fileName: string | null }> } }>;
}

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/**
 * A film kept in parts (Out 1, eight files): the whole film's subtitles, best
 * guess first. One made for the whole film is cut at the parts' lengths; an
 * upload already split one file per part is used file by file. "Try on part
 * 1" plays it over part 1 first (it starts at 0 there). After, any part can
 * be synced by eye, and "shift every part" moves the rest the same.
 */
function FilmPartsSubtitles({ groupId }: { groupId: string }) {
  const { show } = useToasts();
  const [data, setData] = useState<PartsChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [results, setResults] = useState<Array<{ label: string; ok: boolean; message: string }> | null>(null);
  const [all, setAll] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await adminApi<PartsChoices>(`/api/admin/subtitles/parts?groupId=${encodeURIComponent(groupId)}`));
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }

  async function use(c: PartsChoices["candidates"][number]) {
    if (!data) return;
    const files = orderUploadFiles(c.candidate.files ?? []);
    const split = uploadKind(c.candidate, data.parts.length).kind === "split";
    const fileIds = split ? files.map((f) => f.fileId) : [c.candidate.fileId];
    if (!confirm(`Put this subtitle on all ${data.parts.length} parts? ${split ? `${files.length} downloads` : "One download"}, unless already tried.`)) return;
    setBusy(c.candidate.fileId);
    try {
      const r = await adminApi<{ results: Array<{ label: string; ok: boolean; message: string }> }>("/api/admin/subtitles/parts", {
        method: "POST",
        body: { groupId, fileIds },
      });
      setResults(r.results);
      const ok = r.results.filter((x) => x.ok).length;
      show(ok === r.results.length ? "ok" : "err", `Added to ${ok} of ${r.results.length} parts.`);
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(null);
    }
  }

  const first = data?.parts[0];
  const list = data ? (all ? data.candidates : data.candidates.slice(0, FIRST_FEW)) : [];
  return (
    <>
      <h3 className="adm-section">Subtitles for the whole film</h3>
      <p className="hint">
        This is one film kept in several files. A subtitle made for the whole film is cut across the parts at their lengths; an
        upload that already comes one file per part is used file by file. <b>Try on part 1</b> plays it over part 1 first. If a
        part is then a little off (releases cut in slightly different places), sync that part by eye: it offers to shift every
        part the same.
      </p>
      {!data ? (
        <div className="adm-acts">
          <button type="button" disabled={loading} onClick={() => void load()}>
            {loading ? "Searching…" : "Find subtitles for the whole film"}
          </button>
        </div>
      ) : null}
      {error ? <div className="error">{error}</div> : null}
      {data ? (
        <>
          <p className="hint">
            {data.parts.length} parts: {data.parts.map((p) => `${p.label} ${clock(p.durationMs)}`).join(" · ")} (
            {clock(data.parts.reduce((s, p) => s + p.durationMs, 0))} in all).
          </p>
          {!data.candidates.length ? <p className="hint">OpenSubtitles has no English subtitles for this film.</p> : null}
          <div className="adm-list-box">
            {list.map((c, i) => {
              const files = c.candidate.files ?? [];
              const what = uploadKind(c.candidate, data.parts.length);
              const split = what.kind === "split";
              const onePart = what.kind === "onePart" ? data.parts[(what.part ?? 1) - 1] : undefined;
              const unusable = what.kind === "mismatch" || what.kind === "onePart";
              return (
                <div key={c.candidate.fileId} className="adm-ep">
                  <span className="adm-ep-n">{i === 0 ? <b className="adm-best">Best guess</b> : `${i + 1}.`}</span>
                  <span className="adm-ep-t">
                    {c.candidate.release || c.candidate.fileName || "subtitle"}
                    <span className="hint">
                      {" "}
                      ·{" "}
                      {split
                        ? `one file per part (${files.length})`
                        : what.kind === "onePart"
                          ? `only part ${what.part}`
                          : what.kind === "mismatch"
                            ? `${files.length} files, but ${data.parts.length} parts`
                            : "whole film"}{" "}
                      ·{" "}
                      {c.tags.join(" · ")}
                    </span>
                  </span>
                  {onePart ? (
                    <a className="btn ghost" href={`/admin/subtitles/sync?itemId=${encodeURIComponent(onePart.itemId)}&fileId=${c.candidate.fileId}`}>
                      Try on part {what.part}
                    </a>
                  ) : first && !split && what.kind === "whole" ? (
                    <a className="btn ghost" href={`/admin/subtitles/sync?itemId=${encodeURIComponent(first.itemId)}&fileId=${c.candidate.fileId}`}>
                      Try on part 1
                    </a>
                  ) : null}
                  <button type="button" className={i === 0 ? undefined : "secondary"} disabled={busy !== null || unusable} onClick={() => void use(c)}>
                    {busy === c.candidate.fileId ? "Adding…" : `Use for all ${data.parts.length} parts`}
                  </button>
                </div>
              );
            })}
          </div>
          {data.candidates.length > FIRST_FEW && !all ? (
            <button type="button" className="secondary" onClick={() => setAll(true)}>
              Show all {data.candidates.length}
            </button>
          ) : null}
          {results ? (
            <p className="adm-note">
              {results.map((r) => (
                <span key={r.label}>
                  {r.label}: {r.ok ? `added ${r.message}` : r.message}
                  <br />
                </span>
              ))}
              Open any part to sync it by eye; saving there offers to shift every part the same.
            </p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

