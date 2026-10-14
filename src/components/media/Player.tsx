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
import { captionFontPx } from "@/lib/caption-size";
import {
  consumeEcho,
  DRIFT_CHECK_INTERVAL_MS,
  endCooldownOnPlaying,
  expectFromPlan,
  HEARTBEAT_INTERVAL_MS,
  IN_SYNC_SECONDS,
  newDriftControl,
  PAUSED_MATCH_SECONDS,
  planDrift,
  planExplicit,
  startCooldown,
  targetPosition,
  type ExpectedRemote,
  type RoomPosition,
} from "@/lib/party-sync";
import { importOrReload } from "@/lib/chunk-reload";
import { getFocusableElements } from "@/lib/tv/spatial-nav";
import {
  clampTime,
  createOkPressGuard,
  nextSpeed,
  PLAYER_SHORTCUTS,
  resolveMediaKey,
  resolvePlayerKey,
  resolveTvRemoteKey,
  type PlayerAction,
  type TvFocusZone,
} from "@/lib/player-keys";

/**
 * What sits beside the player in a watch party room (PartyRoomClient): the
 * chat / guest links / End panel, or, once chat has moved to a phone, the
 * bar that brings it back; on a TV or phone, the chat overlay when open.
 */
const PLAYER_SIDE_PANEL = ".party-room-side:not([hidden]), .party-chat-away, .party-chat-overlay";

/** The "‹ Back / title" bar above the player (the watch page and the party room). */
const PLAYER_TOP_BAR = ".player-bar";

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
/** Watch party: a refused play() is tried again this often, this many times (a slow seek can take seconds). */
const PLAY_RETRY_MS = 500;
/** Start together: a play this far or more ahead is scheduled rather than done now. */
const SCHEDULE_MIN_MS = 20;
/** Start together: how often to check whether the film has buffered at the agreed spot (the room stops waiting after 8 s anyway). */
const READY_CHECK_MS = 150;
const READY_CHECKS = 60;
/** Watch party: how often this screen says where its film is (for the drift beside names). */
const REPORT_INTERVAL_MS = 5000;
/** "Sync me" is offered once this screen has been this far from the room for SYNC_ME_AFTER_TICKS seconds running. */
const SYNC_ME_SECONDS = 1.5;
const SYNC_ME_AFTER_TICKS = 4;
const PLAY_RETRIES = 20;
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
  /** This stream is the room's one heartbeat source (party-sync.ts, heartbeatRole). */
  sendsHeartbeat: boolean;
  /** This stream steers itself by the heartbeat: a viewer without control. Controllers never do. */
  followsHeartbeat: boolean;
  /** The server's clock, as estimated from round trips; every position below is stamped with it. */
  serverNow: () => number;
  sendSync: (action: "play" | "pause" | "seek", positionSeconds: number) => void;
  /** Heartbeat while playing; see HEARTBEAT_INTERVAL_MS. */
  sendPosition: (positionSeconds: number) => void;
  lastSync: { action: "play" | "pause" | "seek"; positionSeconds: number; paused: boolean; at: number; by: string } | null;
  /** The leader's heartbeat, which followers steer toward. */
  lastPosition: { positionSeconds: number; at: number } | null;
  /** The room's state on (re)joining. */
  initialState: { positionSeconds: number; paused: boolean; at: number } | null;
  /** A controller asked this player to seek ("↩ 1:02:13", undoing a jump); a new id each time. Sent to the room like the viewer's own seek. */
  seekRequest?: { to: number; id: number } | null;
  /** Every few seconds: where this screen's film is, for the drift beside names. */
  sendReport?: (positionSeconds: number, paused: boolean) => void;
  /** This screen has been more than SYNC_ME_SECONDS from the room for a while (true), or is back in step (false). */
  onOutOfStep?: (outOfStep: boolean) => void;
  /** "Sync me": jump this screen to the room now; a new id each time. Not sent to anyone. */
  syncNowRequest?: number | null;
  /** Start together: get to this spot, paused, and say ready once buffered. */
  prepare?: { id: string; positionSeconds: number } | null;
  sendReady?: (id: string) => void;
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

  /** TV remote: on the "‹ Back" bar above the video, on the video, or in the control bar. */
  function tvZone(target: HTMLElement | null): TvFocusZone {
    if (target?.closest?.(PLAYER_TOP_BAR)) return "topbar";
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
      case "focusTopBar": {
        // The bar above the video shows only while the controls do (tv.css),
        // so they are held up for as long as focus is on it.
        const back = document.querySelector<HTMLElement>(`${PLAYER_TOP_BAR} a, ${PLAYER_TOP_BAR} button`);
        if (!back) return;
        holdControls();
        // The bar is still hidden on this frame when the controls were not
        // showing, and a hidden link cannot take focus: keep trying for a
        // few frames. If it never shows, let the controls idle out again.
        let tries = 0;
        const tryFocus = () => {
          back.focus();
          if (document.activeElement === back) return;
          if (++tries < 20) requestAnimationFrame(tryFocus);
          else player.current?.controls.resume();
        };
        tryFocus();
        return;
      }
      case "moveTopBar": {
        // Left/right along "‹ Back" and, in a watch party, "Chat".
        const bar = Array.from(document.querySelectorAll<HTMLElement>(`${PLAYER_TOP_BAR} a, ${PLAYER_TOP_BAR} button`))
          .filter((el) => el.getClientRects().length > 0)
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        const i = target ? bar.indexOf(target) : -1;
        bar[i + action.direction]?.focus();
        holdControls();
        return;
      }
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

  /**
   * One OK press, one action (player-keys.ts, createOkPressGuard): on a TV the
   * WebView "clicks" the focused element again when OK is released, and
   * Vidstack's buttons, having already acted on the keydown, took that as a
   * second press. The player's own toggle notes its OK presses directly
   * (it stops the keydown before it reaches the window); a Vidstack button's
   * is seen once the keydown has bubbled back up.
   */
  const okGuard = useRef(createOkPressGuard());
  useEffect(() => {
    const inPlayer = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest(".player-stage");
    function afterKeydown(event: KeyboardEvent) {
      if (!tvModeRef.current || !inPlayer(event.target)) return;
      okGuard.current.noteKeydown(event.key, event.defaultPrevented, performance.now());
    }
    function swallowEcho(event: Event) {
      if (!tvModeRef.current || !inPlayer(event.target)) return;
      const key = event instanceof KeyboardEvent ? event.key : undefined;
      if (!okGuard.current.shouldSwallow(event.type, key, performance.now())) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    const echoes = ["keyup", "pointerdown", "pointerup", "mousedown", "mouseup", "click"];
    // Bubble phase: after the focused control's own keydown handler has run.
    window.addEventListener("keydown", afterKeydown);
    // Capture phase: before Vidstack's button sees the echo.
    for (const type of echoes) window.addEventListener(type, swallowEcho, true);
    return () => {
      window.removeEventListener("keydown", afterKeydown);
      for (const type of echoes) window.removeEventListener(type, swallowEcho, true);
    };
  }, []);

  // TV remote keys. Capture phase on window, so they arrive before anything
  // inside the player: with focus on the player element, Vidstack's layout
  // marked OK handled first and the toggle never ran.
  useEffect(() => {
    function onTvKey(event: KeyboardEvent) {
      if (!tvModeRef.current || event.defaultPrevented) return;
      // Play/pause on the remote means the film, wherever focus is: in the
      // watch party's chat panel, on the "‹ Back" bar, anywhere. (The checks
      // below hand keys outside the player back to the page.)
      const media = resolveMediaKey(event.key);
      if (media) {
        event.preventDefault();
        event.stopPropagation();
        runActionRef.current(media);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      // "Tap to join the film" is a real button: OK presses it.
      if (target?.closest?.(".party-tap-to-join")) return;
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
      // Anything else outside the player (a watch party's side panel) keeps
      // its keys; the "‹ Back" bar above the video is part of the player's
      // own up/down order.
      if (target && !target.closest(`.player-stage, ${PLAYER_TOP_BAR}`) && target !== document.body) return;
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
      // Stopped here, so the guard's window listener never sees it: note it now.
      if (target && target.closest(".player-stage")) okGuard.current.noteKeydown(event.key, true, performance.now());
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
  /*
   * Subtitles sit on the picture, wherever the picture is.
   *
   * The layout layer (controls and captions) is anchored to the whole stage,
   * while the video takes its own shape in the middle of it. On a desk the
   * two are nearly the same box. On a phone held upright the stage is the
   * full height and the picture a 150px band across the middle, so captions
   * drawn at the bottom of the layer sat 250px below the picture they
   * belong to. The gap between the two bottoms is measured here and handed
   * to CSS (--caption-lift); the controls stay at the bottom, in thumb reach.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const watched = new Set<Element>();
    const observer = new ResizeObserver(() => place());
    function place() {
      if (!stage) return;
      const video = stage.querySelector("video");
      const layer = stage.querySelector(".plyr");
      if (!video || !layer) return;
      for (const el of [video, layer]) {
        if (!watched.has(el)) {
          watched.add(el);
          observer.observe(el);
        }
      }
      const box = video.getBoundingClientRect();
      const gap = layer.getBoundingClientRect().bottom - box.bottom;
      stage.style.setProperty("--caption-lift", `${Math.max(0, Math.round(gap))}px`);
      // And at one size against the picture on every screen (caption-size.ts).
      const size = captionFontPx(box, { width: video.videoWidth, height: video.videoHeight });
      stage.style.setProperty("--caption-size", `${size}px`);
    }
    observer.observe(stage);
    // Media events don't bubble, so they are caught on the way down. These
    // are the moments the picture's size becomes known or changes.
    stage.addEventListener("loadedmetadata", place, true);
    stage.addEventListener("resize", place, true);
    document.addEventListener("fullscreenchange", place);
    place();
    return () => {
      observer.disconnect();
      stage.removeEventListener("loadedmetadata", place, true);
      stage.removeEventListener("resize", place, true);
      document.removeEventListener("fullscreenchange", place);
    };
  }, []);

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
    if (document.activeElement?.closest(`.plyr__controls, ${PLAYER_SIDE_PANEL}, ${PLAYER_TOP_BAR}`)) {
      focusVideo();
      return true;
    }
    return false;
  });

  /**
   * Watch-party sync (the rules are in party-sync.ts).
   *
   * `party` is read through a ref, never from a closure. The listeners below
   * are bound once per stream, and they used to read `party.isController`
   * as it was at that moment: for the creator that is true from the first
   * render, but anyone handed control later (the TV, in the 2026-10-14 test)
   * stayed `false` in those listeners for good, so their play/pause/seek —
   * by click or by remote key alike — was never sent.
   *
   * `expectedRemote` keeps the changes this player was just told to make, so
   * the play/pause/seeked events they cause are not sent back as the
   * viewer's own (consumeEcho).
   *
   * A follower (no control) steers toward the leader: `followTarget` is the
   * last stamped position heard, carried forward to now once a second, and
   * small drift is taken out with playbackRate rather than a seek.
   */
  const partyRef = useRef(party);
  partyRef.current = party;
  const expectedRemote = useRef<ExpectedRemote | null>(null);
  /** Nothing goes out until the room's own state has been applied: autoplay at the resume point would otherwise drag everyone there. */
  const seededPartyState = useRef(false);
  const driftControl = useRef(newDriftControl());
  const followTarget = useRef<RoomPosition | null>(null);
  /** playbackRate is ours (steering), so it goes back to 1 when steering stops. */
  const rateNudged = useRef(false);
  /**
   * What the room tells this player to do goes to the <video> element itself,
   * not through Vidstack (the same choice ScreenAgent makes for the phone
   * remote). Vidstack's own state can go stale after a pause() followed at
   * once by a seek — which a pause sync does — reading "playing" while the
   * video is paused; its play() then resolved without playing, and that
   * screen stayed paused while the room played on. Vidstack follows the
   * element's own events, so its controls stay right either way.
   */
  function mediaElement(): HTMLVideoElement | null {
    return stageRef.current?.querySelector("video") ?? null;
  }

  function mediaPaused(instance: MediaPlayerInstance): boolean {
    return mediaElement()?.paused ?? instance.paused;
  }

  function mediaTime(instance: MediaPlayerInstance): number {
    return mediaElement()?.currentTime ?? instance.currentTime;
  }

  function mediaPause(instance: MediaPlayerInstance) {
    const video = mediaElement();
    if (video) video.pause();
    else void instance.pause();
  }

  function mediaSeek(instance: MediaPlayerInstance, seconds: number) {
    const video = mediaElement();
    if (video) video.currentTime = seconds;
    else instance.currentTime = seconds;
  }

  /** The room last told this player to play (and has not since said pause). */
  const wantPlaying = useRef(false);
  /**
   * The room is playing but this browser refused to start without a tap.
   * Taken from WatchParty, which tests for autoplay and asks for the click.
   */
  const [needsTap, setNeedsTap] = useState(false);
  const tapButtonRef = useRef<HTMLButtonElement>(null);

  function joinByTap() {
    const instance = player.current;
    const video = mediaElement();
    setNeedsTap(false);
    if (!instance || !video) return;
    // The room kept going while the button waited: join where it is now,
    // not where this screen stopped. A tap is a gesture, so this play is
    // allowed; still the room's doing, not the viewer's.
    const current = partyRef.current;
    const target = roomTarget.current;
    const to = current && target ? targetPosition(target, current.serverNow()) : null;
    const seek = to !== null && Math.abs(video.currentTime - to) > IN_SYNC_SECONDS;
    expectedRemote.current = expectFromPlan({ seekTo: seek ? to : null, setPaused: false }, Date.now());
    if (seek) video.currentTime = to;
    video.play().catch(() => setNeedsTap(true));
  }

  // TV: the button takes focus, so OK presses it.
  useEffect(() => {
    if (needsTap && tvModeRef.current) tapButtonRef.current?.focus();
  }, [needsTap]);

  /**
   * play() for the room. It can be refused (before the first load, or
   * interrupted by a seek still fetching), and a refused play used to be
   * dropped, leaving that screen paused while the room played. Tried again
   * every half second until it takes or the room says pause.
   */
  function playWhenReady(instance: MediaPlayerInstance, attempt = 0) {
    wantPlaying.current = true;
    const video = mediaElement();
    (video ? video.play() : instance.play()).catch((error: unknown) => {
      // The browser will not start sound without a tap (phones, mostly). No
      // retry gets past that: ask for the tap instead of sitting paused.
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        if (wantPlaying.current) setNeedsTap(true);
        return;
      }
      if (attempt >= PLAY_RETRIES) return;
      setTimeout(() => {
        if (!wantPlaying.current || !mediaPaused(instance)) return;
        // The retry's play event is still the room's, not the viewer's.
        expectedRemote.current = expectFromPlan({ seekTo: null, setPaused: false }, Date.now());
        playWhenReady(instance, attempt + 1);
      }, PLAY_RETRY_MS);
    });
  }

  function setSteeringRate(instance: MediaPlayerInstance, rate: number) {
    instance.playbackRate = rate;
    rateNudged.current = rate !== 1;
  }

  function stopSteering(instance: MediaPlayerInstance) {
    if (rateNudged.current) setSteeringRate(instance, 1);
  }

  /** Start together: a play scheduled for the moment everyone starts. */
  const scheduledPlay = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelScheduledPlay() {
    if (scheduledPlay.current) clearTimeout(scheduledPlay.current);
    scheduledPlay.current = null;
  }

  /**
   * An explicit play/pause/seek from a controller, or the room's state on
   * joining. `precise`: land on the spot (joining), rather than leave a
   * follower within SEEK_THRESHOLD_SECONDS to steer in over the next minute.
   */
  function applyExplicit(remote: RoomPosition, precise = false) {
    const instance = player.current;
    const current = partyRef.current;
    if (!instance || !current) return;
    const now = Date.now();
    cancelScheduledPlay();
    // Start together: the room plays from a moment just ahead. Be at the spot
    // now, and start when everyone else does.
    const startsIn = remote.paused ? 0 : remote.at - current.serverNow();
    if (startsIn > SCHEDULE_MIN_MS) {
      if (Math.abs(mediaTime(instance) - remote.positionSeconds) > PAUSED_MATCH_SECONDS) {
        expectedRemote.current = expectFromPlan({ seekTo: remote.positionSeconds, setPaused: null }, now);
        mediaSeek(instance, remote.positionSeconds);
      }
      scheduledPlay.current = setTimeout(() => applyExplicit(remote, precise), startsIn);
      return;
    }
    followTarget.current = current.followsHeartbeat ? remote : null;
    stopSteering(instance);
    const plan = planExplicit(
      { positionSeconds: mediaTime(instance), paused: mediaPaused(instance) },
      remote,
      current.serverNow(),
      current.followsHeartbeat && !precise,
    );
    if (plan.seekTo === null && plan.setPaused === null) return;
    expectedRemote.current = expectFromPlan(plan, now);
    // Pause before seeking, so the seek does not start playing on from the old spot.
    if (plan.setPaused === true) mediaPause(instance);
    if (plan.seekTo !== null) {
      mediaSeek(instance, plan.seekTo);
      startCooldown(driftControl.current, now);
    }
    if (plan.setPaused === true) {
      wantPlaying.current = false;
      setNeedsTap(false);
    }
    if (plan.setPaused === false) playWhenReady(instance);
  }

  /** A follower's once-a-second correction toward where the leader is now. */
  /**
   * Own drift, for "Sync me": how far this screen is from the room, from the
   * last stamped position heard (any role). The heartbeat source is the
   * room's reference and has nothing to compare against.
   */
  const roomTarget = useRef<RoomPosition | null>(null);
  const outOfStepTicks = useRef(0);
  const reportedOutOfStep = useRef(false);

  function checkOwnDrift() {
    const instance = player.current;
    const current = partyRef.current;
    const target = roomTarget.current;
    let off = false;
    if (instance && current && target && !target.paused && !current.sendsHeartbeat && !mediaPaused(instance)) {
      const drift = Math.abs(mediaTime(instance) - targetPosition(target, current.serverNow()));
      off = drift > SYNC_ME_SECONDS;
    }
    outOfStepTicks.current = off ? outOfStepTicks.current + 1 : 0;
    const now = outOfStepTicks.current >= SYNC_ME_AFTER_TICKS;
    if (now !== reportedOutOfStep.current) {
      reportedOutOfStep.current = now;
      current?.onOutOfStep?.(now);
    }
  }

  useEffect(() => {
    const instance = player.current;
    const current = partyRef.current;
    const target = roomTarget.current;
    if (!party?.syncNowRequest || !instance || !current || !target) return;
    const now = Date.now();
    const to = targetPosition(target, current.serverNow());
    stopSteering(instance);
    // The room's position, not the viewer's choice: not sent to anyone.
    expectedRemote.current = expectFromPlan({ seekTo: to, setPaused: target.paused ? null : false }, now);
    startCooldown(driftControl.current, now);
    mediaSeek(instance, to);
    if (!target.paused && mediaPaused(instance)) playWhenReady(instance);
    outOfStepTicks.current = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.syncNowRequest]);

  function steer() {
    const instance = player.current;
    const current = partyRef.current;
    if (!instance) return;
    checkOwnDrift();
    const target = followTarget.current;
    if (!current?.followsHeartbeat || !target || target.paused || mediaPaused(instance)) {
      stopSteering(instance);
      return;
    }
    const now = Date.now();
    const plan = planDrift(
      { positionSeconds: mediaTime(instance), rate: instance.playbackRate, seeking: mediaElement()?.seeking ?? instance.state.seeking },
      targetPosition(target, current.serverNow()),
      driftControl.current,
      now,
    );
    if (plan.kind === "rate") {
      setSteeringRate(instance, plan.rate);
    } else if (plan.kind === "seek") {
      stopSteering(instance);
      expectedRemote.current = expectFromPlan({ seekTo: plan.to, setPaused: null }, now);
      mediaSeek(instance, plan.to);
    }
  }
  const steerRef = useRef(steer);
  steerRef.current = steer;

  useEffect(() => {
    const timer = setInterval(() => steerRef.current(), DRIFT_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!party?.initialState || !player.current) return;
    roomTarget.current = party.initialState;
    seededPartyState.current = true;
    applyExplicit(party.initialState, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.initialState]);

  useEffect(() => {
    const instance = player.current;
    if (!party?.seekRequest || !instance) return;
    // Not an expected echo: the seeked this causes goes out as this viewer's seek.
    mediaSeek(instance, party.seekRequest.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.seekRequest]);

  /**
   * Start together: pause at the agreed spot, and once buffered there say
   * ready. Nothing plays until the room's scheduled "play" arrives.
   */
  useEffect(() => {
    const instance = player.current;
    const current = partyRef.current;
    if (!party?.prepare || !instance || !current) return;
    const { id, positionSeconds } = party.prepare;
    const now = Date.now();
    cancelScheduledPlay();
    stopSteering(instance);
    roomTarget.current = { positionSeconds, paused: true, at: current.serverNow() };
    followTarget.current = current.followsHeartbeat ? roomTarget.current : null;
    const seek = Math.abs(mediaTime(instance) - positionSeconds) > PAUSED_MATCH_SECONDS;
    const pause = !mediaPaused(instance);
    expectedRemote.current = expectFromPlan({ seekTo: seek ? positionSeconds : null, setPaused: pause ? true : null }, now);
    wantPlaying.current = false;
    if (pause) mediaPause(instance);
    if (seek) mediaSeek(instance, positionSeconds);
    let checks = 0;
    const poll = setInterval(() => {
      const video = mediaElement();
      // HAVE_FUTURE_DATA: enough buffered to start playing from here.
      const ready = video ? video.readyState >= 3 && !video.seeking : true;
      if (ready) partyRef.current?.sendReady?.(id);
      if (ready || ++checks > READY_CHECKS) clearInterval(poll);
    }, READY_CHECK_MS);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.prepare]);

  useEffect(() => cancelScheduledPlay, []);

  useEffect(() => {
    if (!party?.lastSync) return;
    const { positionSeconds, paused, at } = party.lastSync;
    roomTarget.current = { positionSeconds, paused, at };
    applyExplicit({ positionSeconds, paused, at });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.lastSync]);

  useEffect(() => {
    const instance = player.current;
    if (party?.lastPosition) roomTarget.current = { ...party.lastPosition, paused: false };
    // Controllers never follow heartbeats: two of them doing so chased each other.
    if (!party?.lastPosition || !party.followsHeartbeat || !instance) return;
    followTarget.current = { ...party.lastPosition, paused: false };
    // Heartbeats only come while the room is playing, so a follower that
    // stalled or missed the play is set going again.
    if (mediaPaused(instance)) {
      expectedRemote.current = expectFromPlan({ seekTo: null, setPaused: false }, Date.now());
      playWhenReady(instance);
    }
    steer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.lastPosition]);

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
      // Its own chunk, so after a deploy it can be gone: reload once (chunk-reload.ts).
      provider.library = () => importOrReload(() => import("hls.js"));
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
    // In a watch party the room says where to be, not this viewer's own
    // resume point. A seek set before the media could take it may not have
    // stuck, so the room's state is applied again now that it can.
    const current = partyRef.current;
    if (current) {
      if (seeded.current || !current.initialState) return;
      seeded.current = true;
      applyExplicit(current.initialState, true);
      return;
    }
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

    /** Sends a viewer's own play/pause/seek to the room, with where they are, if they hold control. */
    function shareWithParty(action: "play" | "pause" | "seek") {
      const current = partyRef.current;
      if (!current?.isController || !seededPartyState.current) return;
      const event =
        action === "seek" ? { kind: "seeked" as const, positionSeconds: instance!.currentTime } : { kind: action };
      if (consumeEcho(expectedRemote.current, event, Date.now())) return;
      current.sendSync(action, instance!.currentTime);
    }

    const onPlay = () => {
      report("");
      setIsPaused(false);
      shareWithParty("play");
    };
    const onPause = () => {
      report("/Progress", { IsPaused: true });
      setIsPaused(true);
      shareWithParty("pause");
    };
    const onSeeked = () => shareWithParty("seek");
    // A follower's seek has landed: heartbeats may be listened to again.
    const onPlaying = () => {
      endCooldownOnPlaying(driftControl.current, Date.now());
      setNeedsTap(false);
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

    // Watch party: the room's one heartbeat source says where it is every few
    // seconds while playing (the creator, or the controller that acted last;
    // party-room.ts names it). Followers steer toward it.
    const heartbeat = setInterval(() => {
      const current = partyRef.current;
      if (!current?.isController || !current.sendsHeartbeat || !seededPartyState.current || mediaPaused(instance)) return;
      current.sendPosition(mediaTime(instance));
    }, HEARTBEAT_INTERVAL_MS);

    // Every screen with the film open says where it is, for the drift shown
    // beside each name (WatchParty does the same every second).
    const reporter = setInterval(() => {
      const current = partyRef.current;
      if (!current?.sendReport || !seededPartyState.current) return;
      current.sendReport(mediaTime(instance), mediaPaused(instance));
    }, REPORT_INTERVAL_MS);

    instance.addEventListener("play", onPlay);
    instance.addEventListener("pause", onPause);
    instance.addEventListener("seeked", onSeeked);
    instance.addEventListener("playing", onPlaying);
    instance.addEventListener("ended", onEnded);
    instance.addEventListener("error", onError);

    return () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      clearInterval(reporter);
      instance.removeEventListener("play", onPlay);
      instance.removeEventListener("seeked", onSeeked);
      instance.removeEventListener("playing", onPlaying);
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
        // In a watch party the room decides: autoplay used to start the film
        // as the page loaded, and a controller's player then told the whole
        // (paused) room to play.
        autoPlay={!party}
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
        {needsTap ? (
          <button ref={tapButtonRef} type="button" className="party-tap-to-join" onClick={joinByTap}>
            <PlayIcon />
            <span>Tap to join the film</span>
          </button>
        ) : null}

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
