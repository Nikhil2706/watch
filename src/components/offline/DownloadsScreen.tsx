"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Player, type PlayerSubtitle } from "@/components/media/Player";
import { getOfflineBridge, offlineSupported, prepareForOffline } from "@/lib/offline/bridge";
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
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const revoking = useRef<string[]>([]);

  const refresh = useCallback(async () => {
    const bridge = getOfflineBridge();
    if (!bridge) {
      setBundles([]);
      return;
    }
    try {
      setBundles(await bridge.list());
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
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [busy, refresh]);

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
      const revoke: string[] = [];
      const subtitles: PlayerSubtitle[] = [];
      for (const track of bundle.subtitles ?? []) {
        const text = await bridge.readText(bundle.itemId, track.filename);
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

  async function remove(bundle: OfflineBundle) {
    const bridge = getOfflineBridge();
    if (!bridge) return;
    if (!confirm(`Delete "${bundle.title}" from this device?`)) return;
    try {
      await bridge.remove(bundle.itemId);
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
        <button className="btn ghost" onClick={close}>
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
          This app is older than the site. Your downloads still play; updating the app
          restores managing them.
        </p>
      ) : null}
      {error ? <p className="msg err">{error}</p> : null}

      {bundles === null ? (
        <p className="note">Reading your downloads…</p>
      ) : bundles.length === 0 ? (
        <p className="note">
          Nothing downloaded yet. Open a film and choose Download to keep it on this device.
        </p>
      ) : (
        <ul className="dl-list">
          {bundles.map((bundle) => (
            <li key={bundle.itemId} className="dl-row">
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
              <div className="dl-actions">
                {bundle.state === "ready" ? (
                  <button className="btn" onClick={() => void open(bundle)}>
                    Play
                  </button>
                ) : null}
                <button className="btn danger" onClick={() => void remove(bundle)}>
                  Delete
                </button>
              </div>
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
