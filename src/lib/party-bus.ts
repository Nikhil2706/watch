import "server-only";

import { randomUUID } from "node:crypto";

import { asRow, asRows, getDb } from "./db";
import type { PartyIdentity } from "./party-identity";
import {
  addMember,
  applyHeartbeat,
  applySync,
  broadcast,
  canControl,
  createRoom,
  currentPosition,
  dropLeaderIf,
  findOrigin,
  participantList,
  removeMember,
  stampTime,
  type Member,
  type PartyChatMessage,
  type PartyEvent,
  type PartyGrants,
  type RoomState,
} from "./party-room";

/**
 * Watch-party realtime, moved into the gate process and off WebSockets.
 *
 * Why this exists at all: the previous implementation lived in
 * scripts/party-server.mts and spoke WebSocket over `/ws/party`. That path was
 * never routed — production fronts this app with a *remotely managed*
 * Cloudflare tunnel (`cloudflared tunnel run --token-file …`) whose ingress
 * rules live in the Cloudflare dashboard, not in any file on the host — so
 * every watch party silently did nothing: chat never sent, playback never
 * synced, and the room looked entirely normal while being inert.
 *
 * SSE is plain chunked HTTP to the same :3000 origin the tunnel already
 * serves, which is the one thing known to work here (measured: frames arrive
 * ~1s apart through Cloudflare, not buffered). Client -> server goes over
 * ordinary POSTs. Same split the phone remote uses; see remote-bus.ts.
 *
 * The realtime hub HAD to move into the gate rather than stay a separate
 * process: room state (playback position, who is present) is in-memory, and a
 * second process cannot see the gate's subscribers. This also means the
 * `party` container is now redundant — running it alongside this would be
 * actively harmful, because its empty-room sweep counts *its own* WebSocket
 * connections, would see zero for every room, and would auto-end every live
 * party after fifteen minutes. The sweep moved here with everything else.
 *
 * In-memory room state, same single-process assumption as remote-bus.ts and
 * ratelimit.ts. Chat messages and controller grants are persisted (they were
 * already), so the only thing a restart loses is the extrapolated playback
 * position and the participant list, both of which rebuild as clients
 * reconnect.
 */

const HISTORY_LIMIT = 200;
/** A party nobody is in for this long ends itself, rather than staying "live" forever. */
const EMPTY_TIMEOUT_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

export type { PartyChatMessage, PartyEvent, PartyParticipant } from "./party-room";

interface BusState {
  rooms: Map<string, RoomState>;
  emptySince: Map<string, number>;
  sweepTimer: ReturnType<typeof setInterval> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGatePartyBus: BusState | undefined;
}

function bus(): BusState {
  if (!globalThis.__jellyfinGatePartyBus) {
    globalThis.__jellyfinGatePartyBus = { rooms: new Map(), emptySince: new Map(), sweepTimer: null };
  }
  return globalThis.__jellyfinGatePartyBus;
}

function roomState(roomId: string): RoomState {
  const state = bus();
  let room = state.rooms.get(roomId);
  if (!room) {
    room = createRoom(Date.now());
    state.rooms.set(roomId, room);
  }
  return room;
}

/* ------------------------------------------------------------------ *
 * Permissions — the rule itself is canControl() in party-room.ts.
 * ------------------------------------------------------------------ */

function roomGrants(roomId: string): PartyGrants {
  const db = getDb();
  const room = asRow<{ creator_user_id: string }>(
    db.prepare("SELECT creator_user_id FROM party_rooms WHERE id = ?").get(roomId),
  );
  const rows = asRows<{ user_id: string | null; guest_token: string | null }>(
    db.prepare("SELECT user_id, guest_token FROM party_controllers WHERE room_id = ?").all(roomId),
  );
  return {
    creatorUserId: room?.creator_user_id ?? null,
    userIds: rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    guestTokens: rows.flatMap((r) => (r.guest_token ? [r.guest_token] : [])),
  };
}

export function isCreator(roomId: string, identity: PartyIdentity): boolean {
  return identity.kind === "user" && roomGrants(roomId).creatorUserId === identity.id;
}

export function isController(roomId: string, identity: PartyIdentity): boolean {
  return canControl(roomGrants(roomId), identity);
}

export function isRoomLive(roomId: string): boolean {
  const row = asRow<{ ended_at: number | null }>(
    getDb().prepare("SELECT ended_at FROM party_rooms WHERE id = ?").get(roomId),
  );
  return !!row && row.ended_at === null;
}

/* ------------------------------------------------------------------ *
 * Chat persistence — ported unchanged.
 * ------------------------------------------------------------------ */

function saveMessage(roomId: string, identity: PartyIdentity, body: string): PartyChatMessage {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO party_messages (id, room_id, user_id, guest_token, display_name, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      identity.kind === "user" ? identity.id : null,
      identity.kind === "guest" ? identity.id : null,
      identity.displayName,
      body,
      now,
    );
  return { id, kind: identity.kind, displayName: identity.displayName, body, createdAt: now };
}

export function loadHistory(roomId: string): PartyChatMessage[] {
  return asRows<{ id: string; user_id: string | null; display_name: string; body: string; created_at: number }>(
    getDb()
      .prepare(
        `SELECT id, user_id, display_name, body, created_at FROM party_messages
          WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(roomId, HISTORY_LIMIT),
  )
    .reverse()
    .map((r) => ({
      id: r.id,
      kind: r.user_id ? ("user" as const) : ("guest" as const),
      displayName: r.display_name,
      body: r.body,
      createdAt: r.created_at,
    }));
}

/* ------------------------------------------------------------------ *
 * Membership — the room logic itself is in party-room.ts.
 * ------------------------------------------------------------------ */

export function broadcastParticipants(roomId: string): void {
  const room = bus().rooms.get(roomId);
  if (!room) return;
  const grants = roomGrants(roomId);
  broadcast(room, { type: "participants", list: participantList(room, (identity) => canControl(grants, identity)) });
}

/** Opens an event stream for one participant. Returns an unsubscribe function. */
export function joinRoom(
  roomId: string,
  identity: PartyIdentity,
  clientId: string | null,
  send: (event: PartyEvent) => void,
): () => void {
  ensureSweep();
  const room = roomState(roomId);
  const member: Member = { identity, clientId, isCreator: isCreator(roomId, identity), send };
  bus().emptySince.delete(roomId);

  send({ type: "history", messages: loadHistory(roomId) });
  const now = Date.now();
  send({ type: "state", positionSeconds: currentPosition(room, now), paused: room.paused, at: now });
  addMember(room, member);
  broadcastParticipants(roomId);

  return () => {
    removeMember(room, member);
    broadcastParticipants(roomId);
  };
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export const MAX_MESSAGE_CHARS = 1000;

export function postChat(roomId: string, identity: PartyIdentity, rawBody: string): PartyChatMessage | null {
  const body = rawBody.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!body) return null;
  const message = saveMessage(roomId, identity, body);
  const room = bus().rooms.get(roomId);
  if (room) broadcast(room, { type: "chat", message });
  return message;
}

export function postSync(
  roomId: string,
  identity: PartyIdentity,
  clientId: string | null,
  action: "play" | "pause" | "seek",
  positionSeconds: number,
  sentAt: unknown,
): boolean {
  if (!isController(roomId, identity)) return false;
  const room = roomState(roomId);
  const at = stampTime(sentAt, Date.now());
  applySync(room, findOrigin(room, identity.id, clientId), identity, action, positionSeconds, at);
  return true;
}

/** A controller's position while playing; see applyHeartbeat for who is listened to. */
export function postPosition(
  roomId: string,
  identity: PartyIdentity,
  clientId: string | null,
  positionSeconds: number,
  sentAt: unknown,
): boolean {
  if (!isController(roomId, identity)) return false;
  const room = roomState(roomId);
  const at = stampTime(sentAt, Date.now());
  return applyHeartbeat(room, findOrigin(room, identity.id, clientId), positionSeconds, at);
}

export function setController(
  roomId: string,
  identity: PartyIdentity,
  targetId: string,
  grant: boolean,
): boolean {
  if (!isCreator(roomId, identity)) return false;
  const room = bus().rooms.get(roomId);
  const target = room ? [...room.members].find((m) => m.identity.id === targetId) : undefined;
  if (!target) return false;

  const column = target.identity.kind === "user" ? "user_id" : "guest_token";
  if (grant) {
    getDb()
      .prepare(`INSERT INTO party_controllers (room_id, ${column}, granted_at) VALUES (?, ?, ?)`)
      .run(roomId, targetId, Date.now());
  } else {
    getDb().prepare(`DELETE FROM party_controllers WHERE room_id = ? AND ${column} = ?`).run(roomId, targetId);
    if (room) dropLeaderIf(room, targetId);
  }
  broadcastParticipants(roomId);
  return true;
}

/**
 * Tells a room it is over and drops it. The database write is done by
 * endPartyRoom() in party.ts — this is only the notification half, so it is
 * safe to call after an end that happened over HTTP.
 */
export function announceEnded(roomId: string): void {
  const room = bus().rooms.get(roomId);
  if (room) broadcast(room, { type: "ended" });
  bus().rooms.delete(roomId);
  bus().emptySince.delete(roomId);
}

/* ------------------------------------------------------------------ *
 * Empty-room sweep — moved here from scripts/party-server.mts, which can no
 * longer see who is connected.
 * ------------------------------------------------------------------ */

function sweep(): void {
  const state = bus();
  const liveIds = new Set(
    asRows<{ id: string }>(
      getDb()
        .prepare("SELECT id FROM party_rooms WHERE started_at IS NOT NULL AND ended_at IS NULL")
        .all(),
    ).map((r) => r.id),
  );

  for (const roomId of liveIds) {
    if ((state.rooms.get(roomId)?.members.size ?? 0) > 0) {
      state.emptySince.delete(roomId);
      continue;
    }
    const since = state.emptySince.get(roomId);
    if (since === undefined) {
      state.emptySince.set(roomId, Date.now());
    } else if (Date.now() - since >= EMPTY_TIMEOUT_MS) {
      getDb()
        .prepare("UPDATE party_rooms SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
        .run(Date.now(), roomId);
      console.log(`[party] auto-ending empty room ${roomId}`);
      announceEnded(roomId);
    }
  }

  // Rooms ended elsewhere (the creator's End button, which goes over HTTP):
  // tell anyone still holding a stream, then forget them.
  for (const roomId of [...state.rooms.keys()]) {
    if (!liveIds.has(roomId)) announceEnded(roomId);
  }

  for (const roomId of [...state.emptySince.keys()]) {
    if (!liveIds.has(roomId)) state.emptySince.delete(roomId);
  }
}

function ensureSweep(): void {
  const state = bus();
  if (state.sweepTimer) return;
  state.sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  // Never hold the process open for this alone.
  state.sweepTimer.unref?.();
}
