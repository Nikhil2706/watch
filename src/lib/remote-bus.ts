import "server-only";

import { generateId } from "./crypto";

/**
 * Registry of TV "screens" and the command bus a phone uses to drive them.
 *
 * The model: a screen is any browser showing this site on a TV. It registers
 * itself, holds open an SSE stream, and reports what it is playing. A phone
 * signed in to the SAME account lists that user's screens and posts commands
 * at them. Ownership is the entire security model — there is no cross-account
 * control, so a command is authorised simply by the poster's session owning
 * the target screen.
 *
 * SSE rather than WebSocket, deliberately. The watch-party service
 * (scripts/party-server.mts) already speaks a play/pause/seek protocol and
 * would have been the natural home for this, but it needs a `/ws/party`
 * upgrade route at the edge and production runs a *remotely-managed*
 * Cloudflare tunnel (`cloudflared tunnel run --token-file ...`), whose
 * ingress rules live in the Cloudflare dashboard, not in a file on this box.
 * Adding a WebSocket route therefore needs dashboard access this codebase
 * cannot assume. SSE is plain chunked HTTP straight to the gate on :3000,
 * which is already the only thing the tunnel routes — so the remote works
 * with zero infrastructure change.
 *
 * In-memory, not a table — same reasoning as device-pairing.ts and
 * ratelimit.ts: one Node process in front of one Jellyfin box, so there is no
 * second instance to share state with. A gate restart therefore drops the
 * registry, and that is survivable by design: the TV persists its own
 * screenId in localStorage and re-registers on load, and the phone persists
 * the screenId it paired with, so the pairing re-establishes itself without
 * anyone re-entering a code. That trade buys us no schema migration.
 */

/** How long a screen may go without a heartbeat before it is considered gone. */
const SCREEN_TTL_MS = 90 * 1000;
/** Pairing codes are short because they get typed on a phone while squinting at a TV. */
const CODE_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

/** Commands a phone can send to a screen. */
export type RemoteCommand =
  | { type: "navigate"; href: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "playPause" }
  | { type: "seekTo"; positionSeconds: number }
  | { type: "seekBy"; deltaSeconds: number }
  | { type: "back" }
  | { type: "reload" }
  /** Ask the screen to push a fresh state frame; used when a phone first attaches. */
  | { type: "ping" };

/** What a screen reports about itself, so the phone can render "now playing". */
export interface ScreenState {
  /** Current page, so the phone can show where the TV is even when nothing is playing. */
  href: string;
  itemId: string | null;
  title: string | null;
  subtitle: string | null;
  posterUrl: string | null;
  positionSeconds: number | null;
  durationSeconds: number | null;
  paused: boolean;
  /** True while a video element is actually mounted. */
  playing: boolean;
  updatedAt: number;
}

type Subscriber = (command: RemoteCommand) => void;

interface Screen {
  id: string;
  userId: string;
  /** Human label, editable from the phone. */
  name: string;
  /** True once a human has renamed it, so re-registration never clobbers their choice with a User-Agent guess. */
  nameIsCustom: boolean;
  code: string;
  codeExpiresAt: number;
  lastSeen: number;
  state: ScreenState;
  subscribers: Set<Subscriber>;
}

interface BusState {
  screens: Map<string, Screen>;
  lastSweep: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateRemoteBus: BusState | undefined;
}

function bus(): BusState {
  if (!globalThis.__jellyfinGateRemoteBus) {
    globalThis.__jellyfinGateRemoteBus = { screens: new Map(), lastSweep: 0 };
  }
  return globalThis.__jellyfinGateRemoteBus;
}

/**
 * Ambiguity-free alphabet: no O/0, I/1/L, S/5, Z/2. Someone is reading this
 * off a television from across a room.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRTUVWXY346789";

function generateCode(): string {
  let out = "";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function emptyState(): ScreenState {
  return {
    href: "/",
    itemId: null,
    title: null,
    subtitle: null,
    posterUrl: null,
    positionSeconds: null,
    durationSeconds: null,
    paused: true,
    playing: false,
    updatedAt: Date.now(),
  };
}

function sweep(now: number): void {
  const state = bus();
  if (now - state.lastSweep < SWEEP_INTERVAL_MS) return;
  state.lastSweep = now;
  for (const [id, screen] of state.screens) {
    // A screen with a live SSE subscriber is never swept, even if its
    // heartbeat is briefly late — the open stream is the better liveness
    // signal, and dropping it would disconnect a working remote.
    if (screen.subscribers.size > 0) continue;
    if (now - screen.lastSeen > SCREEN_TTL_MS) state.screens.delete(id);
  }
}

/**
 * Screens one account may hold in the registry at once. A household has a
 * television or three, so this is a ceiling on the in-memory map rather than
 * a product limit anyone should ever meet.
 *
 * It's needed because sweep() only reclaims a screen after SCREEN_TTL_MS of
 * silence: POSTing /api/remote/screen in a loop mints entries faster than
 * they expire, growing the map for as long as the loop runs. Eviction
 * deliberately considers only screens with no live SSE subscriber, which
 * splits the two cases cleanly — a real television holds a stream open and is
 * never evicted, while scripted registrations never subscribe at all and are
 * exactly what gets reclaimed.
 */
const MAX_SCREENS_PER_USER = 20;

function evictOverflow(userId: string): void {
  const state = bus();
  const owned = [...state.screens.values()].filter((s) => s.userId === userId);
  if (owned.length < MAX_SCREENS_PER_USER) return;

  const excess = owned.length - MAX_SCREENS_PER_USER + 1;
  const reclaimable = owned
    .filter((s) => s.subscribers.size === 0)
    .sort((a, b) => a.lastSeen - b.lastSeen);
  for (const screen of reclaimable.slice(0, excess)) state.screens.delete(screen.id);
}

/**
 * Called by a TV on load, and again whenever its SSE stream reconnects.
 * `existingId` comes from the TV's localStorage so a reload (or a gate
 * restart) keeps the same identity and any phone paired to it stays paired.
 */
export function registerScreen(input: {
  userId: string;
  existingId?: string | null;
  name?: string | null;
}): { screenId: string; code: string; name: string } {
  const now = Date.now();
  sweep(now);
  const state = bus();

  const existing = input.existingId ? state.screens.get(input.existingId) : undefined;
  // Re-registering only works for the account that owns the screen; a
  // different user presenting someone else's screenId gets a fresh one
  // rather than adopting it.
  if (existing && existing.userId === input.userId) {
    existing.lastSeen = now;
    // Only adopt the device-guessed name if nobody has renamed this screen.
    if (input.name && !existing.nameIsCustom) existing.name = input.name;
    if (existing.codeExpiresAt <= now) {
      existing.code = generateCode();
      existing.codeExpiresAt = now + CODE_TTL_MS;
    }
    return { screenId: existing.id, code: existing.code, name: existing.name };
  }

  evictOverflow(input.userId);

  const id = input.existingId && !state.screens.has(input.existingId) ? input.existingId : generateId();
  const screen: Screen = {
    id,
    userId: input.userId,
    name: input.name?.trim() || "Screen",
    nameIsCustom: false,
    code: generateCode(),
    codeExpiresAt: now + CODE_TTL_MS,
    lastSeen: now,
    state: emptyState(),
    subscribers: new Set(),
  };
  state.screens.set(id, screen);
  return { screenId: id, code: screen.code, name: screen.name };
}

export function heartbeat(screenId: string, userId: string): boolean {
  const screen = bus().screens.get(screenId);
  if (!screen || screen.userId !== userId) return false;
  screen.lastSeen = Date.now();
  return true;
}

export function updateScreenState(
  screenId: string,
  userId: string,
  patch: Partial<ScreenState>,
): boolean {
  const screen = bus().screens.get(screenId);
  if (!screen || screen.userId !== userId) return false;
  screen.lastSeen = Date.now();
  screen.state = { ...screen.state, ...patch, updatedAt: Date.now() };
  return true;
}

export interface ScreenSummary {
  id: string;
  name: string;
  /**
   * "A command sent right now would be delivered" — i.e. there is a live SSE
   * subscriber. Deliberately NOT "we heard from it recently": a screen can
   * register (and keep heartbeating state) without ever opening its command
   * stream, and reporting that as online made the phone show a connected
   * screen that then rejected every command. If this is true, sendCommand
   * succeeds; if it is false, it does not. Nothing else.
   */
  online: boolean;
  /** Last contact of any kind, so the UI can distinguish "never seen" from "was here a moment ago". */
  lastSeenAgoMs: number;
  state: ScreenState;
}

function summarise(screen: Screen, now: number): ScreenSummary {
  return {
    id: screen.id,
    name: screen.name,
    online: screen.subscribers.size > 0,
    lastSeenAgoMs: now - screen.lastSeen,
    state: screen.state,
  };
}

export function listScreens(userId: string): ScreenSummary[] {
  const now = Date.now();
  sweep(now);
  return [...bus().screens.values()]
    .filter((s) => s.userId === userId)
    .map((s) => summarise(s, now))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export function getScreen(screenId: string, userId: string): ScreenSummary | null {
  const screen = bus().screens.get(screenId);
  if (!screen || screen.userId !== userId) return null;
  return summarise(screen, Date.now());
}

/**
 * Claim a screen by the code it is displaying. Returns the screen so the phone
 * can store its id. Codes are scoped to the same account, so this is a
 * convenience for picking the right TV, not a security boundary — which is
 * why an expired or wrong code fails closed rather than falling back to "the
 * only screen you own".
 */
export function claimByCode(code: string, userId: string): ScreenSummary | null {
  const now = Date.now();
  const normalised = code.trim().toUpperCase();
  if (!normalised) return null;
  for (const screen of bus().screens.values()) {
    if (screen.userId !== userId) continue;
    if (screen.code !== normalised) continue;
    if (screen.codeExpiresAt <= now) return null;
    return summarise(screen, now);
  }
  return null;
}

export function renameScreen(screenId: string, userId: string, name: string): boolean {
  const screen = bus().screens.get(screenId);
  if (!screen || screen.userId !== userId) return false;
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return false;
  screen.name = trimmed;
  screen.nameIsCustom = true;
  return true;
}

/** Opens a command stream for a screen. Returns an unsubscribe function. */
export function subscribe(
  screenId: string,
  userId: string,
  onCommand: Subscriber,
): (() => void) | null {
  const screen = bus().screens.get(screenId);
  if (!screen || screen.userId !== userId) return null;
  screen.subscribers.add(onCommand);
  screen.lastSeen = Date.now();
  return () => {
    screen.subscribers.delete(onCommand);
    screen.lastSeen = Date.now();
  };
}

/** Returns false when the screen is unknown, not owned, or has no live listener. */
export function sendCommand(screenId: string, userId: string, command: RemoteCommand): boolean {
  const screen = bus().screens.get(screenId);
  if (!screen || screen.userId !== userId) return false;
  if (screen.subscribers.size === 0) return false;
  for (const subscriber of screen.subscribers) {
    try {
      subscriber(command);
    } catch {
      // A dead stream must not stop the others from getting the command.
    }
  }
  return true;
}
