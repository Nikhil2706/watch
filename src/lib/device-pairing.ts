import "server-only";

import { generateId } from "./crypto";
import {
  authenticateWithQuickConnect,
  authorizeQuickConnect,
  generateDeviceId,
  getQuickConnectState,
  initiateQuickConnect,
  JellyfinError,
} from "./jellyfin";
import { createSessionForLogin } from "./session";

/**
 * TV device-pairing login, built entirely on Jellyfin's own Quick Connect —
 * no password ever exists on the TV side, and nothing new is stored
 * long-term. See DESIGN-tv-mode.md for the full handshake; short version:
 *
 *   TV                              This app                      Jellyfin
 *   --                              --------                      --------
 *   start pairing        ------->   initiateQuickConnect   ----->  issues Code + Secret
 *   shows Code, polls     <-------  {pairId, code}
 *   ...meanwhile, on a phone already signed in to this app...
 *                                   approve(code)           ----->  QuickConnect/Authorize (user's own token)
 *   poll                  ------->  Authenticated? yes      ----->  AuthenticateWithQuickConnect
 *   gets session cookie   <-------  createSessionForLogin
 *
 * `pairId` is this app's own opaque handle, generated separately from
 * Jellyfin's Secret — the browser never holds anything Jellyfin itself
 * considers a credential until the very last step, and even then only the
 * same httpOnly session cookie every other login path already uses.
 *
 * In-memory, not a table: entries live minutes, not days, and — same
 * reasoning as ratelimit.ts — this runs as a single Node process in front
 * of one Jellyfin box, so there is no second instance to share state with.
 * Pinned to globalThis so dev-mode hot reload does not orphan in-flight
 * pairings.
 */

const TTL_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface PairingEntry {
  secret: string;
  code: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

interface PairingState {
  entries: Map<string, PairingEntry>;
  lastSweep: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateDevicePairing: PairingState | undefined;
}

function state(): PairingState {
  if (!globalThis.__jellyfinGateDevicePairing) {
    globalThis.__jellyfinGateDevicePairing = { entries: new Map(), lastSweep: 0 };
  }
  return globalThis.__jellyfinGateDevicePairing;
}

function sweep(now: number): void {
  const store = state();
  if (now - store.lastSweep < SWEEP_INTERVAL_MS) return;
  store.lastSweep = now;
  for (const [pairId, entry] of store.entries) {
    if (entry.expiresAt <= now || entry.consumed) store.entries.delete(pairId);
  }
}

export async function startDevicePairing(): Promise<{
  pairId: string;
  code: string;
  expiresInSeconds: number;
}> {
  const now = Date.now();
  sweep(now);

  const deviceId = generateDeviceId();
  const quickConnect = await initiateQuickConnect(deviceId);

  const pairId = generateId();
  state().entries.set(pairId, {
    secret: quickConnect.Secret,
    code: quickConnect.Code,
    deviceId,
    createdAt: now,
    expiresAt: now + TTL_MS,
    consumed: false,
  });

  return { pairId, code: quickConnect.Code, expiresInSeconds: Math.floor(TTL_MS / 1000) };
}

export type PollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "authenticated"; sessionId: string; username: string };

/**
 * Called by the TV, repeatedly, until it gets an answer. Only mints a
 * session and consumes the entry once Jellyfin itself reports the code as
 * authenticated — a second poll after that always sees "expired" rather
 * than minting a second session, which is what makes the code single-use
 * from this app's side as well as Jellyfin's.
 */
export async function pollDevicePairing(
  pairId: string,
  userAgent: string | null,
  ip: string | null,
): Promise<PollResult> {
  const now = Date.now();
  sweep(now);

  const entry = state().entries.get(pairId);
  if (!entry || entry.consumed || entry.expiresAt <= now) return { status: "expired" };

  let quickConnect;
  try {
    quickConnect = await getQuickConnectState(entry.secret);
  } catch (error) {
    if (error instanceof JellyfinError && error.status === 404) {
      state().entries.delete(pairId);
      return { status: "expired" };
    }
    throw error;
  }

  if (!quickConnect.Authenticated) return { status: "pending" };

  entry.consumed = true;
  state().entries.delete(pairId);

  const auth = await authenticateWithQuickConnect(entry.secret, entry.deviceId);
  if (!auth.AccessToken || !auth.User?.Id) {
    throw new Error("Jellyfin returned an unexpected Quick Connect auth payload.");
  }

  const sessionId = createSessionForLogin({
    jellyfinUserId: auth.User.Id,
    username: auth.User.Name ?? "TV",
    jellyfinToken: auth.AccessToken,
    jellyfinDeviceId: entry.deviceId,
    userAgent,
    ip,
  });

  return { status: "authenticated", sessionId, username: auth.User.Name ?? "TV" };
}

/**
 * Called from an already-authenticated browser (the `/pair` page) to
 * approve a code shown on a TV. Uses that person's own Jellyfin token —
 * this app never touches a password to do this.
 */
export async function approveDevicePairing(
  code: string,
  userToken: string,
  userDeviceId: string,
): Promise<boolean> {
  return authorizeQuickConnect(userToken, userDeviceId, code);
}
