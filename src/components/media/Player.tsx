"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Video player.
 *
 * Two paths, decided server-side by Jellyfin's PlaybackInfo:
 *
 *  direct — the original file, streamed byte-for-byte through /jf/*. The
 *           <video> element does its own Range requests and seeking works
 *           natively. No transcoding, so no CPU cost on the server.
 *
 *  hls    — Jellyfin transcodes to HLS. Safari plays that natively; every other
 *           browser needs hls.js, which is imported dynamically so the ~25 kB
 *           gzipped library is only fetched when a title actually needs it.
 *
 * Both URLs are same-origin /jf/* paths, so the session cookie rides along
 * automatically and no credential is ever handed to this component.
 */

const TICKS_PER_SECOND = 10_000_000;
const PROGRESS_INTERVAL_MS = 10_000;

interface PlayerProps {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  mode: "direct" | "hls";
  src: string;
  startSeconds: number;
  transcodeReasons: string[];
}

export function Player({
  itemId,
  mediaSourceId,
  playSessionId,
  mode,
  src,
  startSeconds,
  transcodeReasons,
}: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  /* --- source attachment ------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let destroyed = false;
    // Typed loosely: hls.js is only imported on the branch that needs it.
    let hls: { destroy: () => void } | null = null;

    async function attach() {
      if (!video) return;

      const nativeHls = video.canPlayType("application/vnd.apple.mpegurl") !== "";

      if (mode === "direct" || nativeHls) {
        video.src = src;
        return;
      }

      const { default: Hls } = await import("hls.js");
      if (destroyed) return;

      if (!Hls.isSupported()) {
        setError("This browser cannot play the transcoded stream.");
        return;
      }

      const instance = new Hls({
        // Jellyfin transcodes just ahead of the playhead, so a large forward
        // buffer target only makes it work harder for segments the viewer may
        // never reach. Keep it modest — this matters on a slow server.
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      });

      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        // Network and media errors are often recoverable; only give up if the
        // recovery attempt itself fails.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          instance.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          instance.recoverMediaError();
        } else {
          setError("Playback failed. The server may still be starting the transcode.");
          instance.destroy();
        }
      });

      instance.loadSource(src);
      instance.attachMedia(video);
      hls = instance;
    }

    attach().catch(() => setError("Could not start playback."));

    return () => {
      destroyed = true;
      hls?.destroy();
    };
  }, [mode, src]);

  /* --- resume position --------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || startSeconds <= 0) return;

    function seekToStart() {
      if (!video) return;
      // For HLS the transcode already begins at the requested offset, so
      // seeking again would double-apply it.
      if (mode === "direct" && Math.abs(video.currentTime - startSeconds) > 2) {
        video.currentTime = startSeconds;
      }
    }

    video.addEventListener("loadedmetadata", seekToStart, { once: true });
    return () => video.removeEventListener("loadedmetadata", seekToStart);
  }, [startSeconds, mode]);

  /* --- progress reporting ------------------------------------------ */
  /**
   * Feeds Jellyfin the playback position so its own "Continue watching" row
   * stays correct. Reporting through /jf/* means these calls are authenticated
   * by the session cookie like everything else.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const base = {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      PlayMethod: mode === "direct" ? "DirectStream" : "Transcode",
      CanSeek: true,
    };

    function report(path: string, extra: Record<string, unknown> = {}, keepalive = false) {
      const body = JSON.stringify({
        ...base,
        PositionTicks: Math.round((video?.currentTime ?? 0) * TICKS_PER_SECOND),
        IsPaused: video?.paused ?? false,
        ...extra,
      });
      // Failures here are cosmetic — they cost a resume position, not playback.
      void fetch(`/jf/Sessions/Playing${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive,
      }).catch(() => {});
    }

    const onPlay = () => report("");
    const onPause = () => report("/Progress", { IsPaused: true });
    const onEnded = () => report("/Stopped");
    const timer = setInterval(() => {
      if (!video.paused) report("/Progress");
    }, PROGRESS_INTERVAL_MS);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);

    return () => {
      clearInterval(timer);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      // keepalive so the final position survives the page navigation that is
      // usually what triggered this cleanup. Also tells Jellyfin to tear down
      // the transcode instead of leaving ffmpeg running.
      report("/Stopped", {}, true);
    };
  }, [itemId, mediaSourceId, playSessionId, mode]);

  return (
    <div className="player-stage">
      {error ? (
        <div className="player-msg">
          <strong>Playback problem</strong>
          {error}
        </div>
      ) : null}

      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        preload="metadata"
        onCanPlay={() => setReady(true)}
        onError={() =>
          setError(
            mode === "direct"
              ? "The browser refused this file."
              : "The transcoded stream did not start.",
          )
        }
        style={error ? { display: "none" } : undefined}
      />

      {!ready && !error && mode === "hls" ? (
        <div className="player-msg" style={{ position: "absolute" }}>
          <strong>Preparing stream…</strong>
          {transcodeReasons.length > 0
            ? `Transcoding because: ${transcodeReasons.join(", ")}. This can take a while on a slow server.`
            : "Starting the transcode."}
        </div>
      ) : null}
    </div>
  );
}
