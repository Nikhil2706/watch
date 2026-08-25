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
import { useEffect, useRef, useState } from "react";

import { useTvBack } from "@/components/tv/TvProvider";

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
const DOUBLE_TAP_WINDOW_MS = 300;
const CENTER_BUTTON_AUTOHIDE_MS = 2500;
const SEEK_FLASH_MS = 600;
const SEEK_SECONDS = 10;

function PlayIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
    </svg>
  );
}

function SeekBackIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SeekForwardIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

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

/**
 * Watch-party playback sync, threaded through from a page composing
 * <Player> with usePartySocket() (src/components/party/usePartySocket.ts).
 * Optional — a normal solo /watch/[id] never passes this, and every branch
 * below is a no-op without it.
 */
export interface PlayerPartySync {
  isController: boolean;
  sendSync: (action: "play" | "pause" | "seek", positionSeconds: number) => void;
  lastSync: { action: "play" | "pause" | "seek"; positionSeconds: number; by: string } | null;
  initialState: { positionSeconds: number; paused: boolean } | null;
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
  party?: PlayerPartySync;
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
  party,
}: PlayerProps) {
  const player = useRef<MediaPlayerInstance>(null);
  const seeded = useRef(false);

  // Mobile tap gestures: single tap reveals a big center play/pause button
  // (instead of the whole video pausing on any stray touch, per clickToPlay
  // being off above); a second tap in the same left/right zone within
  // DOUBLE_TAP_WINDOW_MS seeks instead. Only enabled on touch devices via
  // CSS (globals.css, "hover: none) and (pointer: coarse)") — these refs and
  // handlers are harmless no-ops on desktop since nothing ever calls them
  // there, but kept unconditional here rather than duplicating the
  // component for two input types.
  const [isPaused, setIsPaused] = useState(true);
  const [centerButtonVisible, setCenterButtonVisible] = useState(false);
  const [seekFlash, setSeekFlash] = useState<"back" | "forward" | null>(null);
  const pendingTapZone = useRef<"left" | "center" | "right" | null>(null);
  const pendingTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const centerHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function revealCenterButton() {
    setCenterButtonVisible(true);
    if (centerHideTimer.current) clearTimeout(centerHideTimer.current);
    // Stays up while paused (an obvious "tap to resume" affordance, same as
    // Plyr's own overlaid play button behavior while paused) — only
    // auto-hides again once playback is actually running.
    if (!(player.current?.paused ?? true)) {
      centerHideTimer.current = setTimeout(() => setCenterButtonVisible(false), CENTER_BUTTON_AUTOHIDE_MS);
    }
  }

  function togglePlayPause() {
    const instance = player.current;
    if (!instance) return;
    if (instance.paused) instance.play();
    else instance.pause();
    revealCenterButton();
  }

  function seekBy(deltaSeconds: number, flash: "back" | "forward") {
    const instance = player.current;
    if (!instance) return;
    const duration = Number.isFinite(instance.duration) ? instance.duration : Infinity;
    instance.currentTime = Math.min(Math.max(0, instance.currentTime + deltaSeconds), duration);
    setSeekFlash(flash);
    if (seekFlashTimer.current) clearTimeout(seekFlashTimer.current);
    seekFlashTimer.current = setTimeout(() => setSeekFlash(null), SEEK_FLASH_MS);
  }

  /** A second tap in the SAME zone inside the double-tap window seeks (left/right only); otherwise it's a plain single tap that reveals the center button. */
  function handleZoneTap(zone: "left" | "center" | "right") {
    if (pendingTapTimer.current && pendingTapZone.current === zone) {
      clearTimeout(pendingTapTimer.current);
      pendingTapTimer.current = null;
      pendingTapZone.current = null;
      if (zone === "left") seekBy(-SEEK_SECONDS, "back");
      else if (zone === "right") seekBy(SEEK_SECONDS, "forward");
      return;
    }
    if (pendingTapTimer.current) clearTimeout(pendingTapTimer.current);
    pendingTapZone.current = zone;
    pendingTapTimer.current = setTimeout(() => {
      pendingTapTimer.current = null;
      pendingTapZone.current = null;
      revealCenterButton();
    }, DOUBLE_TAP_WINDOW_MS);
  }

  useEffect(() => {
    return () => {
      if (pendingTapTimer.current) clearTimeout(pendingTapTimer.current);
      if (centerHideTimer.current) clearTimeout(centerHideTimer.current);
      if (seekFlashTimer.current) clearTimeout(seekFlashTimer.current);
    };
  }, []);

  // Tells TvProvider's global keydown handler to stand down on arrow keys
  // while this is mounted — Vidstack's own document-level shortcuts
  // (keyTarget="document" below) already own seeking and playback there,
  // and the two would otherwise fight over the same keys. Escape/Back is
  // NOT suppressed; see the useTvBack registration below.
  useEffect(() => {
    document.body.dataset.tvPlayerOpen = "true";
    return () => {
      delete document.body.dataset.tvPlayerOpen;
    };
  }, []);

  // Back/Escape in the player: exit fullscreen if fullscreen (most TV
  // browsers already do this natively before JS ever sees the key, but not
  // all of them), otherwise fall through to the default (browser history
  // back, landing on the item page this was opened from).
  useTvBack(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return true;
    }
    return false;
  });

  /**
   * Watch-party sync. applyingRemoteSync suppresses the outbound send that
   * the play/pause listeners below would otherwise fire in response to a
   * state change THIS effect itself just caused — without it, applying a
   * remote "pause" would immediately re-broadcast "pause" right back,
   * which is harmless in itself but pointless network chatter, and with a
   * genuine round-trip delay could occasionally reorder into a flicker.
   * Cleared on a short timer rather than synchronously after the
   * play()/pause()/currentTime call: Vidstack's own event dispatch isn't
   * guaranteed same-tick.
   */
  const applyingRemoteSync = useRef(false);
  const seededPartyState = useRef(false);

  useEffect(() => {
    if (!party?.initialState || seededPartyState.current || !player.current) return;
    seededPartyState.current = true;
    applyingRemoteSync.current = true;
    player.current.currentTime = party.initialState.positionSeconds;
    if (party.initialState.paused) player.current.pause();
    else player.current.play().catch(() => {});
    setTimeout(() => {
      applyingRemoteSync.current = false;
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.initialState]);

  useEffect(() => {
    if (!party?.lastSync || !player.current) return;
    applyingRemoteSync.current = true;
    const { action, positionSeconds } = party.lastSync;
    player.current.currentTime = positionSeconds;
    if (action === "pause") player.current.pause();
    else if (action === "play") player.current.play().catch(() => {});
    setTimeout(() => {
      applyingRemoteSync.current = false;
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.lastSync]);

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

    const onPlay = () => {
      report("");
      setIsPaused(false);
      if (party?.isController && !applyingRemoteSync.current) party.sendSync("play", instance.currentTime);
    };
    const onPause = () => {
      report("/Progress", { IsPaused: true });
      setIsPaused(true);
      if (party?.isController && !applyingRemoteSync.current) party.sendSync("pause", instance.currentTime);
    };
    const onSeeked = () => {
      if (party?.isController && !applyingRemoteSync.current) party.sendSync("seek", instance.currentTime);
    };
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
    instance.addEventListener("seeked", onSeeked);
    instance.addEventListener("ended", onEnded);
    instance.addEventListener("error", onError);

    return () => {
      clearInterval(timer);
      instance.removeEventListener("play", onPlay);
      instance.removeEventListener("seeked", onSeeked);
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

        {/*
          Mobile-only (globals.css gates the whole block to touch devices).
          Three invisible zones over the video: left/right double-tap to
          seek, any single tap reveals the center play/pause button below.
          Taps aren't stopped from bubbling, so Plyr's own idle-based
          controls bar still shows on the same tap independently of this.
        */}
        <div className="mobile-tap-zones" aria-hidden="true">
          <div className="mobile-tap-zone mobile-tap-zone-left" onClick={() => handleZoneTap("left")} />
          <div className="mobile-tap-zone mobile-tap-zone-center" onClick={() => handleZoneTap("center")} />
          <div className="mobile-tap-zone mobile-tap-zone-right" onClick={() => handleZoneTap("right")} />
        </div>

        {centerButtonVisible ? (
          <button
            type="button"
            className="mobile-center-toggle"
            aria-label={isPaused ? "Play" : "Pause"}
            onClick={(event) => {
              event.stopPropagation();
              togglePlayPause();
            }}
          >
            {isPaused ? <PlayIcon /> : <PauseIcon />}
          </button>
        ) : null}

        {seekFlash ? (
          <div className={`mobile-seek-flash mobile-seek-flash-${seekFlash}`} aria-hidden="true">
            {seekFlash === "back" ? <SeekBackIcon /> : <SeekForwardIcon />}
            <span>10</span>
          </div>
        ) : null}

        {/*
          clickToPlay off: Plyr's default gesture toggles play/pause on any
          pointerup over the whole video area, which on a phone means a tap
          meant to reveal the controls bar (or just a stray touch) pauses
          the film — the mobile tap zones above replace it with a
          reveal-then-confirm interaction instead. clickToFullscreen off too:
          its double-tap-anywhere gesture would otherwise fire alongside the
          left/right double-tap-to-seek zones above on the same physical
          tap; the control bar's own fullscreen button is unaffected.
        */}
        <PlyrLayout icons={plyrLayoutIcons} clickToPlay={false} clickToFullscreen={false} />
      </MediaPlayer>

      {transcodeNote ? <p className="player-note">{transcodeNote}</p> : null}
    </div>
  );
}
