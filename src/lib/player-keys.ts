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
  | { kind: "moveControl"; direction: 1 | -1 };

/**
 * A TV remote has arrows, OK, Back and (sometimes) transport keys — no
 * letters, so the keyboard layout above leaves subtitles and settings out
 * of reach. The screen reads top to bottom — "‹ Back" bar, video, control
 * bar — and the keys follow it. On the video: OK plays/pauses, left/right
 * jump 10 s, down opens the control bar, up goes to "‹ Back". In the control
 * bar: left/right move between controls (a slider keeps left/right for
 * itself), up returns to the video. On "‹ Back": down returns to the video,
 * OK leaves the film. Returns null to leave the key alone (OK on a button
 * or link presses it).
 */
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
    return key === "ArrowDown" ? { kind: "leaveControls" } : null;
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
