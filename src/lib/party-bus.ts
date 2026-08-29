import "server-only";

import { randomUUID } from "node:crypto";

import { asRow, asRows, getDb } from "./db";
import type { PartyIdentity } from "./party-identity";

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

export interface PartyChatMessage {
  id: string;
  kind: "user" | "guest";
  displayName: string;
  body: string;
  createdAt: number;
}

export interface PartyParticipant {
  id: string;
  kind: "user" | "guest";
  displayName: string;
  isController: boolean;
}

export type PartyEvent =
  | { type: "history"; messages: PartyChatMessage[] }
  | { type: "state"; positionSeconds: number; paused: boolean }
  | { type: "participants"; list: PartyParticipant[] }
  | { type: "chat"; message: PartyChatMessage }
  | { type: "sync"; action: "play" | "pause" | "seek"; positionSeconds: number; by: string }
  | { type: "ended" };

type Subscriber = (event: PartyEvent) => void;

interface Member {
  identity: PartyIdentity;
  send: Subscriber;
}

interface RoomState {
  members: Set<Member>;
  positionSeconds: number;
  paused: boolean;
  /** Wall-clock time positionSeconds was last known accurate, for extrapolating "now" between syncs. */
  updatedAt: number;
}

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
    room = { members: new Set(), positionSeconds: 0, paused: true, updatedAt: Date.now() };
    state.rooms.set(roomId, room);
  }
  return room;
}

function currentPosition(room: RoomState): number {
  if (room.paused) return room.positionSeconds;
  return room.positionSeconds + (Date.now() - room.updatedAt) / 1000;
}

/* ------------------------------------------------------------------ *
 * Permissions — ported unchanged from the old party-server.
 * ------------------------------------------------------------------ */

export function isCreator(roomId: string, identity: PartyIdentity): boolean {
  if (identity.kind !== "user") return false;
  const row = asRow<{ creator_user_id: string }>(
    getDb().prepare("SELECT creator_user_id FROM party_rooms WHERE id = ?").get(roomId),
  );
  return row?.creator_user_id === identity.id;
}

export function isController(roomId: string, identity: PartyIdentity): boolean {
  if (isCreator(roomId, identity)) return true;
  const column = identity.kind === "user" ? "user_id" : "guest_token";
  const row = asRow<{ n: number }>(
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM party_controllers WHERE room_id = ? AND ${column} = ?`)
      .get(roomId, identity.id),
  );
  return (row?.n ?? 0) > 0;
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
 * Broadcast + membership
 * ------------------------------------------------------------------ */

function broadcast(roomId: string, event: PartyEvent, except?: Member): void {
  const room = bus().rooms.get(roomId);
  if (!room) return;
  for (const member of room.members) {
    if (member === except) continue;
    try {
      member.send(event);
    } catch {
      // One dead stream must not stop the rest of the room from being told.
    }
  }
}

function participantList(roomId: string): PartyParticipant[] {
  const room = bus().rooms.get(roomId);
  if (!room) return [];
  // De-duplicated by identity: one person with the film open in two tabs is
  // one participant, not two.
  const byId = new Map<string, PartyParticipant>();
  for (const member of room.members) {
    if (byId.has(member.identity.id)) continue;
    byId.set(member.identity.id, {
      id: member.identity.id,
      kind: member.identity.kind,
      displayName: member.identity.displayName,
      isController: isController(roomId, member.identity),
    });
  }
  return [...byId.values()];
}

export function broadcastParticipants(roomId: string): void {
  broadcast(roomId, { type: "participants", list: participantList(roomId) });
}

/** Opens an event stream for one participant. Returns an unsubscribe function. */
export function joinRoom(roomId: string, identity: PartyIdentity, send: Subscriber): () => void {
  ensureSweep();
  const room = roomState(roomId);
  const member: Member = { identity, send };
  room.members.add(member);
  bus().emptySince.delete(roomId);

  send({ type: "history", messages: loadHistory(roomId) });
  send({ type: "state", positionSeconds: currentPosition(room), paused: room.paused });
  broadcastParticipants(roomId);

  return () => {
    room.members.delete(member);
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
  broadcast(roomId, { type: "chat", message });
  return message;
}

export function postSync(
  roomId: string,
  identity: PartyIdentity,
  action: "play" | "pause" | "seek",
  positionSeconds: number,
): boolean {
  if (!isController(roomId, identity)) return false;
  const room = roomState(roomId);
  room.positionSeconds = positionSeconds;
  room.paused = action === "pause";
  room.updatedAt = Date.now();
  // Everyone except the person who did it — echoing their own seek back at
  // them makes their player fight itself.
  const origin = [...room.members].find((m) => m.identity.id === identity.id);
  broadcast(roomId, { type: "sync", action, positionSeconds, by: identity.displayName }, origin);
  return true;
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
  broadcast(roomId, { type: "ended" });
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
