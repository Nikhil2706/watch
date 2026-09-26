"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Player, type PlayerSubtitle } from "@/components/media/Player";
import {
  cancelPendingDownload,
  getOfflineBridge,
  offlineSupported,
  pendingOfflineDownloads,
  prepareForOffline,
  resumeOfflineDownloads,
} from "@/lib/offline/bridge";
import type { PendingDownload } from "@/lib/offline/pending";
import { useCloseOnBack } from "@/lib/overlay-back";
import { OFFLINE_BRIDGE_VERSION, type OfflineBundle } from "@/lib/offline/types";

/**
 * The downloads screen — and the one page that has to work with no network at
 * all, which is why the service worker precaches it by name.
 *
 * Playback reuses the ordinary <Player>. That is safe offline because both of
 * its server calls (progress reporting and error reporting) are already
 * fire-and-forget with swallowed rejections, so with no network they fail
 * silently instead of breaking playback. Writing a second, lesser player for
 * offline would have cost the captions menu and the keyboard controls for no
 * gain.
 */

interface Playing {
  bundle: OfflineBundle;
  src: string;
  poster: string | null;
  subtitles: PlayerSubtitle[];
  /** Blob URLs to revoke when this closes. */
  revoke: string[];
}

export function DownloadsScreen() {
  const [bundles, setBundles] = useState<OfflineBundle[] | null>(null);
  const [pending, setPending] = useState<PendingDownload[]>([]);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [posters, setPosters] = useState<Record<string, string | null>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const revoking = useRef<string[]>([]);

  const refresh = useCallback(async () => {
    const bridge = getOfflineBridge();
    if (!bridge) {
      setBundles([]);
      return;
    }
    // Hand over anything the server has finished preparing before listing,
    // so it shows up as downloading on this same pass.
    await resumeOfflineDownloads().catch(() => undefined);
    setPending(pendingOfflineDownloads());
    try {
      const list = await bridge.list();
      setBundles(list);
      // The poster was saved with the bundle precisely so this list is not a
      // column of bare titles when there is no network.
      for (const b of list) {
        void bridge
          .localUrl(b.itemId, "poster")
          .catch(() => null)
          .then((url) => setPosters((prev) => (b.itemId in prev ? prev : { ...prev, [b.itemId]: url })));
      }
      // Playback is never gated on this — see OFFLINE_BRIDGE_VERSION. An old
      // shell can still play what it already holds; only managing downloads
      // needs the app itself updating, and that needs a network anyway, so
      // saying so is actionable rather than a dead end.
      setStale((bridge.version ?? 0) < OFFLINE_BRIDGE_VERSION);
    } catch {
      setError("Could not read your downloads.");
    }
  }, []);

  useEffect(() => {
    void refresh();
    void prepareForOffline();
  }, [refresh]);

  // Poll only while something is actually moving. A downloads screen with
  // nothing in flight has no reason to wake the device up every two seconds.
  const busy = (bundles ?? []).some((b) => b.state === "downloading" || b.state === "queued");
  const waiting = pending.some((p) => p.status !== "failed");
  useEffect(() => {
    if (!busy && !waiting) return;
    // The server side moves in minutes, the device side in seconds.
    const timer = setInterval(() => void refresh(), busy ? 2000 : 5000);
    return () => clearInterval(timer);
  }, [busy, waiting, refresh]);

  useEffect(
    () => () => {
      revoking.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  async function open(bundle: OfflineBundle) {
    const bridge = getOfflineBridge();
    if (!bridge) return;
    setError(null);
    try {
      const src = await bridge.localUrl(bundle.itemId, "media");
      if (!src) {
        setError("That file is missing — try downloading it again.");
        return;
      }
      const poster = await bridge.localUrl(bundle.itemId, "poster");

      // Subtitles go through readText and become blob: URLs rather than being
      // pointed at directly. The local file lives on a different origin from
      // this page, and while <video> does not care, <track> is CORS-checked
      // and would silently load nothing — a film that plays with no subtitles
      // and no error to explain it.
      // One unreadable subtitle must not cost the whole film: playback of
      // something already on the device is never gated (see types.ts).
      const revoke: string[] = [];
      const subtitles: PlayerSubtitle[] = [];
      for (const track of bundle.subtitles ?? []) {
        const text = await bridge.readText(bundle.itemId, track.filename).catch(() => null);
        if (!text) continue;
        const url = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
        revoke.push(url);
        subtitles.push({
          index: track.index,
          label: track.label,
          language: track.language,
          url,
          recommended: track.recommended,
        });
      }
      revoking.current.push(...revoke);

      setPlaying({ bundle, src, poster, subtitles, revoke });
    } catch {
      setError("Could not open that download.");
    }
  }

  function close() {
    if (playing) {
      playing.revoke.forEach((url) => URL.revokeObjectURL(url));
      revoking.current = revoking.current.filter((u) => !playing.revoke.includes(u));
    }
    setPlaying(null);
  }
  // Back in the app leaves the player for the list rather than the page.
  const closeRef = useRef(close);
  closeRef.current = close;
  const closeForBack = useCallback(() => closeRef.current(), []);
  useCloseOnBack(playing !== null, closeForBack);

  async function remove(bundle: OfflineBundle) {
    const bridge = getOfflineBridge();
    if (!bridge) return;
    setConfirming(null);
    try {
      await bridge.remove(bundle.itemId);
      setPosters((prev) => {
        const { [bundle.itemId]: _gone, ...rest } = prev;
        return rest;
      });
      await refresh();
    } catch {
      setError("Could not delete that download.");
    }
  }

  if (!offlineSupported()) {
    return (
      <p className="note">
        Downloads live in the app. Open this page in the Watch app on a phone, tablet or
        Windows PC to keep films for offline.
      </p>
    );
  }

  if (playing) {
    const recommended = playing.subtitles.find((s) => s.recommended);
    return (
      <div className="dl-player">
        <button className="btn ghost dl-player-back" onClick={close}>
          ← Back to downloads
        </button>
        <Player
          itemId={playing.bundle.itemId}
          mediaSourceId="offline"
          playSessionId="offline"
          mode="direct"
          src={playing.src}
          title={playing.bundle.title}
          poster={playing.poster}
          startSeconds={0}
          transcodeReasons={[]}
          subtitles={playing.subtitles}
          defaultSubtitleIndex={recommended ? recommended.index : null}
        />
      </div>
    );
  }

  return (
    <>
      {stale ? (
        <p className="note">
          This app is older than the site. Your downloads still play, but subtitles need the
          app update — accept it next time the app offers one.
        </p>
      ) : null}
      {error ? <p className="msg err">{error}</p> : null}

      {pending.length > 0 ? (
        <ul className="dl-list">
          {pending.map((p) => (
            <li key={p.itemId} className="dl-row">
              <div className="dl-meta">
                <div className="dl-title">{p.title}</div>
                <div className="dl-sub">
                  {p.status === "failed"
                    ? (p.error ?? "The server could not prepare this title.")
                    : `Preparing on the server${p.progress > 0 ? ` · ${p.progress}%` : "…"} · downloads by itself when ready`}
                </div>
                {p.status !== "failed" ? (
                  <div className="dl-bar is-server">
                    <i style={{ width: `${Math.max(p.progress, 3)}%` }} />
                  </div>
                ) : null}
              </div>
              <div className="dl-actions">
                <button
                  className="btn ghost"
                  onClick={() => {
                    cancelPendingDownload(p.itemId);
                    setPending(pendingOfflineDownloads());
                  }}
                >
                  {p.status === "failed" ? "Dismiss" : "Cancel"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {bundles === null ? (
        <p className="note">Reading your downloads…</p>
      ) : bundles.length === 0 ? (
        pending.length === 0 ? (
          <p className="note">
            Nothing downloaded yet. Open a film and choose Keep offline to have it on this device.
          </p>
        ) : null
      ) : (
        <ul className="dl-list">
          {bundles.map((bundle) => (
            <li key={bundle.itemId} className="dl-row has-poster">
              {posters[bundle.itemId] ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local file URL, not something next/image can optimise
                <img className="dl-poster" src={posters[bundle.itemId]!} alt="" />
              ) : (
                <div className="dl-poster is-empty" aria-hidden="true" />
              )}
              <div className="dl-meta">
                <div className="dl-title">
                  {bundle.title}
                  {bundle.year ? <span className="dl-year"> ({bundle.year})</span> : null}
                </div>
                <div className="dl-sub">{describe(bundle)}</div>
                {bundle.state === "downloading" ? (
                  <div className="dl-bar">
                    <i style={{ width: `${bundle.progress}%` }} />
                  </div>
                ) : null}
              </div>
              {confirming === bundle.itemId ? (
                <div className="dl-actions dl-confirm">
                  <span>Delete from this device?</span>
                  <button className="btn ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                  <button className="btn danger" onClick={() => void remove(bundle)}>
                    Delete
                  </button>
                </div>
              ) : (
                <div className="dl-actions">
                  {bundle.state === "ready" ? (
                    <button className="btn" onClick={() => void open(bundle)}>
                      ▶ Play
                    </button>
                  ) : null}
                  <button className="btn ghost" onClick={() => setConfirming(bundle.itemId)}>
                    Delete
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function describe(bundle: OfflineBundle): string {
  const subs = bundle.subtitles?.length ?? 0;
  const subtitleNote = subs === 0 ? "no subtitles" : subs === 1 ? "1 subtitle" : `${subs} subtitles`;

  switch (bundle.state) {
    case "ready":
      return `${formatBytes(bundle.bytesDone)} · ${subtitleNote}`;
    case "downloading":
      return `${bundle.progress}% · ${formatBytes(bundle.bytesDone)} of ${formatBytes(bundle.bytesTotal)}`;
    case "queued":
      return "Waiting to start…";
    case "failed":
      return bundle.error ?? "Download failed.";
    default:
      return subtitleNote;
  }
}

function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
