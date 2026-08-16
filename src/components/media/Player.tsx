"use client";

import {
  MediaPlayer,
  MediaProvider,
  Track,
  isHLSProvider,
  type MediaPlayerInstance,
  type MediaProviderAdapter,
} from "@vidstack/react";
import {
  PlyrLayout,
  plyrLayoutIcons,
} from "@vidstack/react/player/layouts/plyr";
import { useEffect, useRef } from "react";

// The Plyr layout rather than Vidstack's default: a single slim control bar
// instead of a large translucent panel, which suits a phone and does not fight
// the artwork.
import "@vidstack/react/player/styles/plyr/theme.css";

/**
 * Video player.
 *
 * Built on Vidstack rather than the browser's native controls. Native controls
 * were adequate on desktop and poor on a phone — the main way this gets used —
 * and their captions menu is close to unusable on a film carrying six subtitle
 * tracks. Vidstack gives a real captions menu, playback speed, keyboard
 * shortcuts and the same look in every browser.
 *
 * Two playback paths, decided server-side by Jellyfin's PlaybackInfo:
 *
 *  direct — the original file, streamed byte-for-byte through /jf/*. Seeking is
 *           plain HTTP range requests, so it is instant.
 *  hls    — Jellyfin transcodes. Safari plays HLS natively; everything else
 *           uses hls.js.
 *
 * Every URL is a same-origin /jf/* path, so the session cookie rides along and
 * no credential is ever handed to this component.
 */

const TICKS_PER_SECOND = 10_000_000;
const PROGRESS_INTERVAL_MS = 10_000;

/**
 * Tells the server this browser hit a playback error — a decode failure, an
 * unsupported codec, a stream that dropped mid-transfer. This is the only way
 * "the file is actually corrupt" or "this browser can't play this codec"
 * would otherwise be visible at all: from the server's side, a failed stream
 * just looks like a client that stopped asking for more bytes.
 */
function reportPlayerError(detail: {
  message: string;
  code?: number | string;
  itemId: string;
  mode: "direct" | "hls";
}) {
  void fetch("/api/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "player",
      message: detail.message,
      itemId: detail.itemId,
      detail: { code: detail.code, mode: detail.mode },
    }),
    keepalive: true,
  }).catch(() => {});
}

export interface PlayerSubtitle {
  index: number;
  label: string;
  language: string | null;
  url: string;
  recommended: boolean;
}

interface PlayerProps {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  mode: "direct" | "hls";
  src: string;
  title: string;
  poster?: string | null;
  startSeconds: number;
  transcodeReasons: string[];
  subtitles: PlayerSubtitle[];
  defaultSubtitleIndex: number | null;
}

export function Player({
  itemId,
  mediaSourceId,
  playSessionId,
  mode,
  src,
  title,
  poster,
  startSeconds,
  transcodeReasons,
  subtitles,
  defaultSubtitleIndex,
}: PlayerProps) {
  const player = useRef<MediaPlayerInstance>(null);
  const seeded = useRef(false);

  /**
   * Supply our own hls.js.
   *
   * Vidstack otherwise fetches hls.js from a public CDN at runtime. That would
   * be the only third-party request this app makes, it would fail on a
   * restricted network, and it undercuts the point of a self-hosted setup — so
   * the copy already in the bundle is handed over explicitly.
   */
  function onProviderChange(provider: MediaProviderAdapter | null) {
    if (isHLSProvider(provider)) {
      provider.library = () => import("hls.js");
      provider.config = {
        // Jellyfin transcodes just ahead of the playhead, so a large forward
        // buffer only makes the server work harder for segments nobody may
        // reach. Modest values matter on a slow box.
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
      };
    }
  }

  /** Resume once, when the media is actually ready to seek. */
  function onCanPlay() {
    if (seeded.current || startSeconds <= 0) return;
    seeded.current = true;
    // For HLS the transcode already starts at the requested offset, so seeking
    // again would double-apply it.
    if (mode === "direct" && player.current) {
      player.current.currentTime = startSeconds;
    }
  }

  /**
   * Feeds Jellyfin the playback position so its own Continue Watching stays
   * correct, and tells it to stop transcoding when the viewer leaves.
   */
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;

    const base = {
      ItemId: itemId,
      MediaSourceId: mediaSourceId,
      PlaySessionId: playSessionId,
      PlayMethod: mode === "direct" ? "DirectStream" : "Transcode",
      CanSeek: true,
    };

    function report(path: string, extra: Record<string, unknown> = {}, keepalive = false) {
      void fetch(`/jf/Sessions/Playing${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...base,
          PositionTicks: Math.round((instance?.currentTime ?? 0) * TICKS_PER_SECOND),
          IsPaused: instance?.paused ?? false,
          ...extra,
        }),
        keepalive,
      }).catch(() => {});
    }

    const onPlay = () => report("");
    const onPause = () => report("/Progress", { IsPaused: true });
    const onEnded = () => report("/Stopped");
    const onError = () => {
      const mediaError = instance.state.error;
      reportPlayerError({
        message: mediaError?.message || "Playback error",
        code: mediaError?.code,
        itemId,
        mode,
      });
    };

    const timer = setInterval(() => {
      if (!instance.paused) report("/Progress");
    }, PROGRESS_INTERVAL_MS);

    instance.addEventListener("play", onPlay);
    instance.addEventListener("pause", onPause);
    instance.addEventListener("ended", onEnded);
    instance.addEventListener("error", onError);

    return () => {
      clearInterval(timer);
      instance.removeEventListener("play", onPlay);
      instance.removeEventListener("pause", onPause);
      instance.removeEventListener("ended", onEnded);
      instance.removeEventListener("error", onError);
      // keepalive so the final position survives the navigation that usually
      // triggers this cleanup.
      report("/Stopped", {}, true);
    };
  }, [itemId, mediaSourceId, playSessionId, mode]);

  const transcodeNote =
    mode === "hls" && transcodeReasons.length > 0
      ? `Transcoding — ${transcodeReasons.join(", ")}`
      : null;

  return (
    <div className="player-stage">
      <MediaPlayer
        ref={player}
        className="vds-player"
        title={title}
        src={
          mode === "hls"
            ? { src, type: "application/x-mpegurl" }
            : { src, type: "video/mp4" }
        }
        poster={poster ?? undefined}
        crossOrigin="anonymous"
        playsInline
        autoPlay
        // Keyboard shortcuts work anywhere on the page, not only when the video
        // itself holds focus.
        keyTarget="document"
        onProviderChange={onProviderChange}
        onCanPlay={onCanPlay}
      >
        <MediaProvider>
          {subtitles.map((track) => (
            <Track
              // Vidstack's Track declares its own string `key` prop, which
              // collides with React's; a string satisfies both.
              key={String(track.index)}
              src={track.url}
              kind="subtitles"
              label={track.recommended ? `${track.label} (recommended)` : track.label}
              lang={track.language ?? undefined}
              // Honoured on load, unlike the native `default` attribute which
              // browsers ignore once the element has already been parsed.
              default={track.index === defaultSubtitleIndex}
            />
          ))}
        </MediaProvider>

        <PlyrLayout icons={plyrLayoutIcons} />
      </MediaPlayer>

      {transcodeNote ? <p className="player-note">{transcodeNote}</p> : null}
    </div>
  );
}
