/**
 * Keyboard controls for the player — YouTube's layout, plus VLC's jump sizes.
 *
 * Kept as a pure key → action table so it is tested, and so the help overlay
 * (PLAYER_SHORTCUTS) is the same list the handler uses rather than a second
 * copy that drifts.
 */

export type PlayerAction =
  | { kind: "toggle" }
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "seek"; by: number }
  | { kind: "seekPercent"; percent: number }
  | { kind: "seekTo"; where: "start" | "end" }
  | { kind: "frame"; direction: 1 | -1 }
  | { kind: "volume"; by: number }
  | { kind: "mute" }
  | { kind: "fullscreen" }
  | { kind: "captions" }
  | { kind: "cycleCaptions" }
  | { kind: "speed"; by: number }
  | { kind: "speedReset" }
  | { kind: "next" }
  | { kind: "help" };

export interface KeyLike {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

const MEDIA_KEYS: Record<string, PlayerAction> = {
  MediaPlayPause: { kind: "toggle" },
  MediaPlay: { kind: "play" },
  MediaPause: { kind: "pause" },
  MediaStop: { kind: "pause" },
  MediaFastForward: { kind: "seek", by: 10 },
  MediaRewind: { kind: "seek", by: -10 },
  MediaTrackNext: { kind: "next" },
};

/**
 * Where focus is when a TV remote key arrives in the player: on the video
 * itself, on a button in the control bar, or on one of its sliders.
 */
export type TvFocusZone = "video" | "controls" | "slider" | "topbar";

export type TvRemoteAction =
  | PlayerAction
  /** Reveal the control bar and focus its first control. */
  | { kind: "showControls" }
  /** Leave the control bar: focus back on the video. */
  | { kind: "leaveControls" }
  /** Focus the "‹ Back" link in the bar above the video. */
  | { kind: "focusTopBar" }
  /** Move along the control bar. */
  | { kind: "moveControl"; direction: 1 | -1 }
  /** Move along the bar above the video ("‹ Back", and a watch party's "Chat"). */
  | { kind: "moveTopBar"; direction: 1 | -1 };

/**
 * A TV remote has arrows, OK, Back and (sometimes) transport keys — no
 * letters, so the keyboard layout above leaves subtitles and settings out
 * of reach. The screen reads top to bottom — "‹ Back" bar, video, control
 * bar — and the keys follow it. On the video: OK plays/pauses, left/right
 * jump 10 s, down opens the control bar, up goes to "‹ Back". In the control
 * bar: left/right move between controls (a slider keeps left/right for
 * itself), up returns to the video. On the bar above ("‹ Back", and in a
 * watch party "Chat"): left/right move along it, down returns to the video,
 * OK presses what is focused. Returns null to leave the key alone (OK on a button
 * or link presses it).
 */
/**
 * One OK press, one action.
 *
 * On the Android TV app a single OK on the player's focused Pause button
 * paused and played again at once (2026-10-14, Hisense Android 9, adb
 * KEYCODE_DPAD_CENTER): in a watch party the chat logged "paused at 1:38"
 * then "played from 1:38". The WebView on a TV runs its own remote
 * navigation, which "clicks" the focused element when OK is released,
 * pointer events included. Vidstack's buttons had already acted on the
 * keydown, and react to pointerup as well, so the release pressed them a
 * second time. (A desktop browser has no such release click, so one Enter
 * was always one action there.)
 *
 * The rule, the same for every control in the player: whatever acts on the
 * OK keydown is the press. If the keydown was handled (default prevented,
 * by Vidstack's button or by the player's own toggle), the OK release and any
 * pointer, mouse or click events that follow within OK_ECHO_MS are that same
 * press and are swallowed. If nothing handled it (a plain button such as
 * "Tap to join the film"), the release and its click go through untouched:
 * they are the press.
 */
export const OK_ECHO_MS = 700;

const OK_KEYS = new Set(["Enter", " "]);
const ECHO_EVENTS = new Set(["pointerdown", "pointerup", "mousedown", "mouseup", "click"]);

export interface OkPressGuard {
  /** After a keydown has been through the page's handlers: was it OK, and did something act on it? */
  noteKeydown(key: string, handled: boolean, now: number): void;
  /** Whether this event is the echo of an OK press already acted on. */
  shouldSwallow(type: string, key: string | undefined, now: number): boolean;
}

export function createOkPressGuard(windowMs = OK_ECHO_MS): OkPressGuard {
  let actedAt = -Infinity;
  return {
    noteKeydown(key, handled, now) {
      if (OK_KEYS.has(key) && handled) actedAt = now;
    },
    shouldSwallow(type, key, now) {
      if (now - actedAt > windowMs) return false;
      if (type === "keyup") return key !== undefined && OK_KEYS.has(key);
      return ECHO_EVENTS.has(type);
    },
  };
}

/**
 * A remote's transport keys (play/pause, play, pause, fast-forward, rewind),
 * whatever has focus. On the Android TV app these arrive from the native
 * layer (MainActivity.dispatchKeyEvent), because Android sends media keys to
 * the media session rather than to the WebView.
 */
export function resolveMediaKey(key: string): PlayerAction | null {
  return MEDIA_KEYS[key] ?? null;
}

export function resolveTvRemoteKey(key: string, zone: TvFocusZone): TvRemoteAction | null {
  const media = MEDIA_KEYS[key];
  if (media) return media;
  if (zone === "video") {
    switch (key) {
      case "Enter":
        return { kind: "toggle" };
      case "ArrowLeft":
        return { kind: "seek", by: -10 };
      case "ArrowRight":
        return { kind: "seek", by: 10 };
      case "ArrowUp":
        return { kind: "focusTopBar" };
      case "ArrowDown":
        return { kind: "showControls" };
    }
    return null;
  }
  if (zone === "topbar") {
    if (key === "ArrowDown") return { kind: "leaveControls" };
    if (key === "ArrowLeft" || key === "ArrowRight") return { kind: "moveTopBar", direction: key === "ArrowLeft" ? -1 : 1 };
    return null;
  }
  if (key === "ArrowUp") return { kind: "leaveControls" };
  if (zone === "controls" && (key === "ArrowLeft" || key === "ArrowRight")) {
    return { kind: "moveControl", direction: key === "ArrowLeft" ? -1 : 1 };
  }
  return null;
}

/** Which action a key press means, or null to leave it to the browser. */
export function resolvePlayerKey(e: KeyLike): PlayerAction | null {
  const ctrl = !!(e.ctrlKey || e.metaKey);
  const key = e.key;

  // Media keys: a TV remote's transport buttons, a keyboard's media row.
  const media = MEDIA_KEYS[key];
  if (media) return media;

  // Arrow jumps, VLC-style by modifier: Shift 3s, plain 5s, Alt 10s, Ctrl 1 min.
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const sign = key === "ArrowLeft" ? -1 : 1;
    const size = ctrl ? 60 : e.altKey ? 10 : e.shiftKey ? 3 : 5;
    return { kind: "seek", by: sign * size };
  }
  // Everything else leaves Ctrl/Cmd/Alt combinations to the browser (copy,
  // find, new tab...).
  if (ctrl || e.altKey) return null;

  // By physical key too: some keyboards and remote-control tools report
  // Shift + "." rather than ">", and Shift + "/" rather than "?".
  if (e.code === "Period") return e.shiftKey ? { kind: "speed", by: 0.25 } : { kind: "frame", direction: 1 };
  if (e.code === "Comma") return e.shiftKey ? { kind: "speed", by: -0.25 } : { kind: "frame", direction: -1 };
  if (e.code === "Slash" && e.shiftKey) return { kind: "help" };

  switch (key) {
    case " ":
    case "k":
    case "K":
      return { kind: "toggle" };
    case "j":
    case "J":
      return { kind: "seek", by: -10 };
    case "l":
    case "L":
      return { kind: "seek", by: 10 };
    case "ArrowUp":
      return { kind: "volume", by: 0.05 };
    case "ArrowDown":
      return { kind: "volume", by: -0.05 };
    case "m":
    case "M":
      return { kind: "mute" };
    case "f":
    case "F":
      return { kind: "fullscreen" };
    case "c":
    case "C":
      return { kind: "captions" };
    case "v":
    case "V":
      return { kind: "cycleCaptions" };
    case "Home":
      return { kind: "seekTo", where: "start" };
    case "End":
      return { kind: "seekTo", where: "end" };
    case ",":
      return { kind: "frame", direction: -1 };
    case ".":
      return { kind: "frame", direction: 1 };
    case "<":
      return { kind: "speed", by: -0.25 };
    case ">":
      return { kind: "speed", by: 0.25 };
    case "=":
      return { kind: "speedReset" };
    case "N":
      return e.shiftKey ? { kind: "next" } : null;
    case "?":
      return { kind: "help" };
  }
  // 0–9 on the main row or the number pad: jump to that tenth of the film.
  const digit = /^Digit(\d)$/.exec(e.code ?? "")?.[1] ?? /^Numpad(\d)$/.exec(e.code ?? "")?.[1] ?? (/^\d$/.test(key) ? key : null);
  if (digit !== null && !e.shiftKey) return { kind: "seekPercent", percent: Number(digit) * 10 };
  return null;
}

/** For the "?" overlay, in the order people reach for them. */
export const PLAYER_SHORTCUTS: ReadonlyArray<[keys: string, what: string]> = [
  ["Space / K", "Play or pause"],
  ["← / →", "Back / forward 5 seconds"],
  ["J / L", "Back / forward 10 seconds"],
  ["Shift + ← / →", "3 seconds"],
  ["Alt + ← / →", "10 seconds"],
  ["Ctrl + ← / →", "1 minute"],
  ["0 – 9", "Jump to 0% – 90%"],
  ["Home / End", "Start / end"],
  [", / .", "Previous / next frame (while paused)"],
  ["↑ / ↓", "Volume"],
  ["M", "Mute"],
  ["C", "Subtitles on / off"],
  ["V", "Next subtitle track"],
  ["< / >", "Slower / faster"],
  ["=", "Normal speed"],
  ["F", "Fullscreen"],
  ["Shift + N", "Next episode"],
  ["?", "This list"],
  ["Media keys", "Play / pause, ±10 seconds, next"],
];

/** Where a frame step lands: about one frame at 24fps, never past the ends. */
export function clampTime(t: number, duration: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(Math.max(0, t), end);
}

export const SPEEDS_MIN = 0.25;
export const SPEEDS_MAX = 3;

export function nextSpeed(current: number, by: number): number {
  const next = Math.round((current + by) * 100) / 100;
  return Math.min(SPEEDS_MAX, Math.max(SPEEDS_MIN, next));
}
