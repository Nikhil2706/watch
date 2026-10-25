"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  NO_CHANGE,
  applyTiming,
  cueAt,
  describeTiming,
  fitTwoPoints,
  formatMs,
  offsetFromLine,
  parseSrt,
  type Cue,
  type Timing,
} from "@/lib/srt-timing";

import { useToasts } from "../../Toasts";

/**
 * Sync a subtitle by eye. The film plays with the subtitle drawn over it
 * (our own overlay, not a <track>, so a change shows at once), and the timing
 * moves by buttons, keys, or by marking a line as being said now. Two lines
 * marked far apart fix a drift (another frame rate). Nothing is written until
 * Save; the first version of the file is kept as .orig.
 */

const STEPS = [-1000, -500, -100, 100, 500, 1000];

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clean(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "");
}

export function SyncWorkspace({
  itemId,
  title,
  files,
  initialFile,
  playback,
}: {
  itemId: string;
  title: string;
  files: string[];
  initialFile: string | null;
  playback: { mode: "direct" | "hls"; src: string } | null;
}) {
  const { show } = useToasts();
  const video = useRef<HTMLVideoElement>(null);
  const [file, setFile] = useState(initialFile);
  const [cues, setCues] = useState<Cue[]>([]);
  const [hasOriginal, setHasOriginal] = useState(false);
  const [timing, setTiming] = useState<Timing>(NO_CHANGE);
  const [nowMs, setNowMs] = useState(0);
  const [mark, setMark] = useState<{ cue: Cue; videoMs: number } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");

  // The film: direct, or HLS through hls.js where the browser can't play it itself.
  useEffect(() => {
    const v = video.current;
    if (!v || !playback) return;
    if (playback.mode === "direct" || v.canPlayType("application/vnd.apple.mpegurl")) {
      v.src = playback.src;
      return;
    }
    let destroyed = false;
    let hls: { destroy: () => void } | null = null;
    void import("hls.js").then(({ default: Hls }) => {
      if (destroyed) return;
      const h = new Hls();
      h.loadSource(playback.src);
      h.attachMedia(v);
      hls = h;
    });
    return () => {
      destroyed = true;
      hls?.destroy();
    };
  }, [playback]);

  const load = useCallback(async () => {
    if (!file) return;
    try {
      const r = await adminApi<{ text: string; hasOriginal: boolean }>(
        `/api/admin/subtitles/sync?itemId=${encodeURIComponent(itemId)}&name=${encodeURIComponent(file)}`,
      );
      setCues(parseSrt(r.text));
      setHasOriginal(r.hasOriginal);
      setTiming(NO_CHANGE);
      setMark(null);
    } catch (e) {
      show("err", message(e));
    }
  }, [file, itemId, show]);

  useEffect(() => {
    void load();
  }, [load]);

  // The clock the overlay follows: smooth while playing.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (video.current) setNowMs(video.current.currentTime * 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const showing = useMemo(() => cueAt(cues, nowMs, timing), [cues, nowMs, timing]);
  const nudge = useCallback((ms: number) => setTiming((t) => ({ ...t, offsetMs: t.offsetMs + ms })), []);

  // Keys: [ and ] move 0.1 s, { and } 0.5 s; space plays/pauses; arrows step 2 s.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const v = video.current;
      if (e.key === "[") nudge(-100);
      else if (e.key === "]") nudge(100);
      else if (e.key === "{") nudge(-500);
      else if (e.key === "}") nudge(500);
      else if (e.key === " " && v) {
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === "ArrowLeft" && v) v.currentTime = Math.max(0, v.currentTime - 2);
      else if (e.key === "ArrowRight" && v) v.currentTime += 2;
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nudge]);

  /** "This line is being said now". A second line, far from the first, fixes drift too. */
  function saidNow(cue: Cue) {
    const videoMs = (video.current?.currentTime ?? 0) * 1000;
    if (mark && mark.cue.index !== cue.index && Math.abs(mark.cue.startMs - cue.startMs) >= 60_000) {
      const fit = fitTwoPoints({ cueMs: mark.cue.startMs, videoMs: mark.videoMs }, { cueMs: cue.startMs, videoMs });
      if ("error" in fit) {
        show("err", fit.error);
        return;
      }
      setTiming(fit);
      setMark(null);
      show("ok", `Two lines placed: ${describeTiming(fit)}.`);
      return;
    }
    setTiming(offsetFromLine(cue, videoMs, timing.scale));
    setMark({ cue, videoMs });
    show("ok", "Placed. If it drifts later in the film, mark another line there too.");
  }

  function jumpTo(cue: Cue) {
    const v = video.current;
    if (!v) return;
    // A moment before the line, so it can be heard coming.
    v.currentTime = Math.max(0, applyTiming(cue.startMs, timing) / 1000 - 1.5);
    setSelected(cue.index);
  }

  async function save() {
    if (!file) return;
    setBusy(true);
    try {
      const r = await adminApi<{ cues: number }>("/api/admin/subtitles/sync", {
        method: "POST",
        body: { itemId, name: file, scale: timing.scale, offsetMs: timing.offsetMs },
      });
      show("ok", `Saved ${r.cues} lines (${describeTiming(timing)}). The first version is kept as ${file}.orig.`);
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    if (!file || !confirm(`Put back the first version of ${file}?`)) return;
    setBusy(true);
    try {
      await adminApi("/api/admin/subtitles/sync", { method: "POST", body: { itemId, name: file, restore: true } });
      show("ok", "The first version is back.");
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  const changed = timing.offsetMs !== 0 || timing.scale !== 1;
  const shown = filter.trim()
    ? cues.filter((c) => clean(c.text).toLowerCase().includes(filter.trim().toLowerCase()))
    : cues;

  if (!files.length) {
    return (
      <section className="adm-card">
        <h2 className="adm-card-title">{title}</h2>
        <p className="hint">This video has no .srt subtitle file next to it. Download one from its Subtitles list first.</p>
      </section>
    );
  }

  return (
    <div className="adm-sync">
      <section className="adm-card">
        <div className="adm-row">
          <h2 className="adm-card-title adm-grow">Sync subtitles · {title}</h2>
          <select value={file ?? ""} onChange={(e) => setFile(e.target.value)} aria-label="Subtitle file">
            {files.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="adm-sync-stage">
          {playback ? (
            // eslint-disable-next-line jsx-a11y/media-has-caption -- the captions are drawn below, on purpose
            <video ref={video} controls playsInline preload="metadata" />
          ) : (
            <p className="hint">This film can&apos;t be played here.</p>
          )}
          {showing ? <div className="adm-sync-cue">{clean(showing.text)}</div> : null}
        </div>

        <div className="adm-sync-controls">
          <span className="adm-sync-now">{formatMs(nowMs).slice(0, 8)}</span>
          <span className="adm-grow adm-sync-shift">
            Shift: <b>{describeTiming(timing)}</b>
            <span className="hint"> · earlier ← → later</span>
          </span>
          {STEPS.map((ms) => (
            <button key={ms} type="button" className="secondary" onClick={() => nudge(ms)}>
              {ms > 0 ? "+" : "−"}
              {Math.abs(ms) / 1000}s
            </button>
          ))}
          <button type="button" className="secondary" disabled={!changed} onClick={() => setTiming(NO_CHANGE)}>
            Reset
          </button>
          <button type="button" disabled={!changed || busy} onClick={() => void save()}>
            Save
          </button>
          {hasOriginal ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => void restore()}>
              Put back the first version
            </button>
          ) : null}
        </div>
        <p className="hint">
          Subtitles early? Move them later (+). Late? Earlier (−). Keys: <b>[ ]</b> ±0.1 s, <b>{"{ }"}</b> ±0.5 s, space plays,
          ← → skip 2 s. Quicker: when you hear a line, press <b>Said now</b> beside it. If it drifts (fine at the start, off by
          the end), do that once near the start and once near the end. Nothing is saved until <b>Save</b>.
        </p>
        {mark ? (
          <p className="adm-note">
            Placed on “{clean(mark.cue.text).slice(0, 60)}”. Mark a second line a minute or more away to fix drift too.
          </p>
        ) : null}
      </section>

      <section className="adm-card">
        <div className="adm-row">
          <h2 className="adm-card-title adm-grow">Lines</h2>
          <input placeholder="Find a line…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="adm-list-box adm-sync-lines">
          {shown.slice(0, 400).map((c) => (
            <div key={c.index} className={`adm-ep${showing?.index === c.index ? " is-on" : ""}${selected === c.index ? " is-picked" : ""}`}>
              <button type="button" className="adm-sync-time" onClick={() => jumpTo(c)} title="Go to a moment before this line">
                {formatMs(applyTiming(c.startMs, timing)).slice(0, 8)}
              </button>
              <span className="adm-ep-t">{clean(c.text)}</span>
              <button type="button" className="secondary" onClick={() => saidNow(c)}>
                Said now
              </button>
            </div>
          ))}
        </div>
        {shown.length > 400 ? <p className="hint">Showing the first 400; find a line to narrow it.</p> : null}
      </section>
    </div>
  );
}
