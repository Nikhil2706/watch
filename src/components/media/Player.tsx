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

import { useTvBack, useTvMode } from "@/components/tv/TvProvider";
import { getFocusableElements } from "@/lib/tv/spatial-nav";
import {
  clampTime,
  nextSpeed,
  PLAYER_SHORTCUTS,
  resolvePlayerKey,
  resolveTvRemoteKey,
  type PlayerAction,
  type TvFocusZone,
} from "@/lib/player-keys";

/**
 * What sits beside the player in a watch party room (PartyRoomClient): the
 * chat / guest links / End panel, or, once chat has moved to a phone, the
 * bar that brings it back.
 */
const PLAYER_SIDE_PANEL = ".party-room-side:not([hidden]), .party-chat-away";

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
  /**
   * Screening guests share one Jellyfin account, so Jellyfin's own UserData
   * would hand the next guest this one's stopping point. When set, the position
   * is mirrored into screening_progress, which is per screening session.
   */
  screeningProgress?: boolean;
  transcodeReasons: string[];
  subtitles: PlayerSubtitle[];
  defaultSubtitleIndex: number | null;
  party?: PlayerPartySync;
  /** The next episode's watch URL, for Shift+N. */
  nextHref?: string | null;
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
  screeningProgress = false,
  transcodeReasons,
  subtitles,
  defaultSubtitleIndex,
  party,
  nextHref = null,
}: PlayerProps) {
  const player = useRef<MediaPlayerInstance>(null);
  const seeded = useRef(false);

  /* ---- Keyboard: YouTube's keys, VLC's jump sizes (lib/player-keys.ts) ----
     Vidstack's built-in shortcuts are switched off (keyDisabled below): they
     covered the basics but said nothing on screen, so a key press gave no
     sign it had landed, and there was no 0–9, Home/End, frame step, subtitle
     cycling, next episode or help. One handler now owns every key. */
  const [osd, setOsd] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCaptionTrack = useRef<number>(-1);

  function flashOsd(text: string) {
    setOsd(text);
    if (osdTimer.current) clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(null), 900);
  }

  function formatClock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
  }

  function runAction(action: PlayerAction) {
    const p = player.current;
    if (!p) return;
    const tracks = p.textTracks
      .toArray()
      .filter((t) => t.kind === "subtitles" || t.kind === "captions");
    switch (action.kind) {
      case "toggle": {
        // Read before acting: paused only flips once the element reacts.
        const wasPaused = p.paused;
        if (wasPaused) void p.play();
        else void p.pause();
        flashOsd(wasPaused ? "▶  Play" : "❚❚  Pause");
        break;
      }
      case "play":
        if (p.paused) void p.play();
        flashOsd("▶  Play");
        break;
      case "pause":
        if (!p.paused) void p.pause();
        flashOsd("❚❚  Pause");
        break;
      // The OSD shows the target, not currentTime read back: the player
      // reports the new time only once the seek lands.
      case "seek": {
        const to = clampTime(p.currentTime + action.by, p.duration);
        p.currentTime = to;
        flashOsd(`${action.by > 0 ? "+" : "−"}${Math.abs(action.by) >= 60 ? `${Math.abs(action.by) / 60} min` : `${Math.abs(action.by)}s`}  ·  ${formatClock(to)}`);
        break;
      }
      case "seekPercent":
        if (Number.isFinite(p.duration) && p.duration > 0) {
          const to = (p.duration * action.percent) / 100;
          p.currentTime = to;
          flashOsd(`${action.percent}%  ·  ${formatClock(to)}`);
        }
        break;
      case "seekTo":
        p.currentTime = action.where === "start" ? 0 : clampTime(p.duration - 1, p.duration);
        flashOsd(action.where === "start" ? "Start" : "End");
        break;
      case "frame":
        if (!p.paused) void p.pause();
        p.currentTime = clampTime(p.currentTime + action.direction / 24, p.duration);
        flashOsd(action.direction > 0 ? "Next frame" : "Previous frame");
        break;
      case "volume": {
        const v = Math.min(1, Math.max(0, Math.round((p.volume + action.by) * 100) / 100));
        p.volume = v;
        if (action.by > 0 && p.muted) p.muted = false;
        flashOsd(`Volume ${Math.round(v * 100)}%`);
        break;
      }
      case "mute": {
        const muted = !p.muted;
        p.muted = muted;
        flashOsd(muted ? "Muted" : `Volume ${Math.round(p.volume * 100)}%`);
        break;
      }
      case "fullscreen":
        if (p.state.fullscreen) void p.exitFullscreen();
        else void p.enterFullscreen();
        break;
      case "captions": {
        if (tracks.length === 0) return flashOsd("No subtitles");
        const showing = tracks.findIndex((t) => t.mode === "showing");
        if (showing >= 0) {
          lastCaptionTrack.current = showing;
          tracks[showing]!.mode = "disabled";
          flashOsd("Subtitles off");
        } else {
          const i = lastCaptionTrack.current >= 0 && lastCaptionTrack.current < tracks.length ? lastCaptionTrack.current : 0;
          tracks[i]!.mode = "showing";
          flashOsd(`Subtitles: ${tracks[i]!.label || "on"}`);
        }
        break;
      }
      case "cycleCaptions": {
        if (tracks.length === 0) return flashOsd("No subtitles");
        const showing = tracks.findIndex((t) => t.mode === "showing");
        if (showing >= 0) tracks[showing]!.mode = "disabled";
        const next = showing + 1;
        if (next >= tracks.length) {
          flashOsd("Subtitles off");
        } else {
          tracks[next]!.mode = "showing";
          lastCaptionTrack.current = next;
          flashOsd(`Subtitles: ${tracks[next]!.label || `track ${next + 1}`}`);
        }
        break;
      }
      case "speed": {
        // Like the seek time: the player reports the new rate a beat late.
        const rate = nextSpeed(p.playbackRate, action.by);
        p.playbackRate = rate;
        flashOsd(`Speed ${rate}×`);
        break;
      }
      case "speedReset":
        p.playbackRate = 1;
        flashOsd("Speed 1×");
        break;
      case "next":
        // replace, not assign: Back from the next episode should leave the
        // player, not reopen (and restart) the episode before it.
        if (nextHref) window.location.replace(nextHref);
        else flashOsd("No next episode");
        break;
      case "help":
        setHelpOpen((open) => !open);
        break;
    }
  }

  // Latest runAction and help state without re-binding the listener on every render.
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;

  const tvMode = useTvMode();
  const tvModeRef = useRef(tvMode);
  tvModeRef.current = tvMode;
  const stageRef = useRef<HTMLDivElement>(null);

  /**
   * The control bar's buttons, left to right: play, mute, subtitles,
   * settings, fullscreen. Not the sliders — a slider keeps left/right for
   * itself, so focus parked on the seek bar could never reach subtitles;
   * seeking is left/right on the video, and a TV remote has its own volume.
   */
  function barControls(): HTMLElement[] {
    const bar = stageRef.current?.querySelector(".plyr__controls");
    if (!bar) return [];
    return Array.from(bar.querySelectorAll<HTMLElement>("button"))
      .filter((el) => el.getClientRects().length > 0 && !el.closest("[role='menu']"))
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  }

  function focusVideo() {
    // Back on the video: the bar may hide itself again when idle.
    player.current?.controls.resume();
    stageRef.current?.querySelector<HTMLElement>(".vds-player")?.focus();
  }

  /**
   * TV: the bar stays up while focus is in it. Left to its idle timer
   * (~2 s) it hid mid-choice and sent focus back to the video, so an OK on
   * subtitles, a moment later, did nothing.
   */
  function holdControls() {
    const controls = player.current?.controls;
    controls?.show();
    controls?.pause();
  }

  /** TV remote: on the video, or in the control bar. */
  function tvZone(target: HTMLElement | null): TvFocusZone {
    if (!target?.closest?.(".plyr__controls")) return "video";
    return target.getAttribute("role") === "slider" ? "slider" : "controls";
  }

  function runTvAction(action: NonNullable<ReturnType<typeof resolveTvRemoteKey>>, target: HTMLElement | null) {
    switch (action.kind) {
      case "showControls": {
        holdControls();
        barControls()[0]?.focus();
        return;
      }
      case "leaveControls":
        focusVideo();
        return;
      case "moveControl": {
        const controls = barControls();
        const i = target ? controls.indexOf(target) : -1;
        const next = controls[i + action.direction];
        if (next) {
          next.focus();
          holdControls();
          return;
        }
        // Right past the last button, in a watch party: into the panel
        // beside the player (chat, guest links, End). TvProvider moves the
        // D-pad through it from there; left or Back comes back to the video.
        if (action.direction === 1) {
          const first = Array.from(document.querySelectorAll(PLAYER_SIDE_PANEL))
            .flatMap((panel) => getFocusableElements(panel))[0];
          if (first) {
            player.current?.controls.resume();
            first.focus();
            return;
          }
        }
        holdControls();
        return;
      }
      default:
        runActionRef.current(action);
    }
  }
  const runTvActionRef = useRef(runTvAction);
  runTvActionRef.current = runTvAction;

  // TV: land on the video, not the bar's "‹ Back" link — the first OK
  // pressed used to leave the film.
  useEffect(() => {
    if (!tvMode) return;
    const frame = requestAnimationFrame(() => focusVideo());
    return () => cancelAnimationFrame(frame);
  }, [tvMode]);

  // TV remote keys. Capture phase on window, so they arrive before anything
  // inside the player: with focus on the player element, Vidstack's layout
  // marked OK handled first and the toggle never ran.
  useEffect(() => {
    function onTvKey(event: KeyboardEvent) {
      if (!tvModeRef.current || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      // An open settings menu keeps up/down/OK (Vidstack moves through it).
      // Left/right mean nothing there, but left unhandled the WebView's own
      // D-pad navigation jumped focus out of the menu (onto fullscreen).
      if (target?.closest?.("[role='menu']")) {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      // Anything outside the player (the bar's Back link) keeps its keys.
      if (target && !target.closest(".player-stage") && target !== document.body) return;
      const zone = tvZone(target);
      const tvAction = resolveTvRemoteKey(event.key, zone);
      if (!tvAction) {
        // An arrow with nothing to do (down in the bar) is still ours: the
        // WebView would otherwise move focus somewhere on its own.
        if (event.key.startsWith("Arrow") && zone !== "slider") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      runTvActionRef.current(tvAction, target);
    }
    window.addEventListener("keydown", onTvKey, true);
    return () => window.removeEventListener("keydown", onTvKey, true);
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && helpOpenRef.current) {
        setHelpOpen(false);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const target = event.target as HTMLElement | null;
      // Typing somewhere (search, a party chat) is not a player command.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      // TV mode: onTvKey above owns the remote.
      if (tvModeRef.current) return;
      // A focused control keeps its own keys: Space presses a button, arrows
      // move a slider — the keyboard-accessibility contract.
      const role = target?.getAttribute?.("role");
      if ((event.key === " " || event.key === "Enter") && (target?.tagName === "BUTTON" || role === "button")) return;
      if (event.key.startsWith("Arrow") && role === "slider") return;
      const action = resolvePlayerKey(event);
      if (!action) return;
      event.preventDefault();
      runActionRef.current(action);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  // while this is mounted — the player's own document-level key handler
  // (above) owns seeking and playback there, and the two would otherwise
  // fight over the same keys. Escape/Back is
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
  //
  // On a TV, Back first steps out of whatever the remote is inside: an open
  // settings/captions menu closes (focus back on its button), the control
  // bar hands focus back to the video; only then does it leave the film.
  useTvBack(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return true;
    }
    if (!tvModeRef.current) return false;
    const stage = stageRef.current;
    const menuButton = stage?.querySelector<HTMLElement>(".plyr__controls [aria-expanded='true']");
    if (menuButton) {
      // Vidstack closes its menu on Escape; a click on the button does not.
      // Dispatched without bubbling: at the document, Escape is TvProvider's
      // Back, which would then leave the film as well.
      const menu = stage?.querySelector(".plyr__menu__container") ?? menuButton;
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: false }));
      menuButton.focus();
      return true;
    }
    if (document.activeElement?.closest(`.plyr__controls, ${PLAYER_SIDE_PANEL}`)) {
      focusVideo();
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

      // A position, and only a position — deliberately not a timeline of plays,
      // pauses and seeks. That distinction is what keeps a screening from
      // becoming the parked viewing-metrics feature by the back door.
      if (screeningProgress) {
        void fetch("/api/screening/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId,
            positionTicks: Math.round((instance?.currentTime ?? 0) * TICKS_PER_SECOND),
          }),
          keepalive,
        }).catch(() => {});
      }
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
    <div className="player-stage" ref={stageRef}>
      <MediaPlayer
        ref={player}
        className="vds-player"
        // TV: where focus lands (TvProvider), so OK plays/pauses.
        data-tv-autofocus="true"
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
        // Keys are handled by the document-level listener above (every
        // shortcut, with on-screen feedback); Vidstack's own set would fight it.
        keyDisabled
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

        {/* Inside the player, so both still show in fullscreen. */}
        {osd ? (
          <div className="player-osd" role="status" aria-live="polite">
            {osd}
          </div>
        ) : null}
        {helpOpen ? (
          <div className="player-help" role="dialog" aria-label="Keyboard shortcuts" onClick={() => setHelpOpen(false)}>
            <div className="player-help-card" onClick={(e) => e.stopPropagation()}>
              <div className="player-help-head">
                <strong>Keyboard shortcuts</strong>
                <button type="button" onClick={() => setHelpOpen(false)} aria-label="Close">
                  ×
                </button>
              </div>
              <dl>
                {PLAYER_SHORTCUTS.map(([keys, what]) => (
                  <div key={keys}>
                    <dt>{keys}</dt>
                    <dd>{what}</dd>
                  </div>
                ))}
              </dl>
            </div>
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
