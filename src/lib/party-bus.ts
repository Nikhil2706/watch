import "server-only";

import { createHmac, randomBytes, randomUUID } from "node:crypto";

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
  excerpt,
  groupReactions,
  REACTION_EMOJI,
  creatorReturned,
  findOrigin,
  GROUP_START_TIMEOUT_MS,
  markReady,
  participantList,
  pauseOrphaned,
  planOrphan,
  type PartyMemberIdentity,
  postNotice,
  removeMember,
  stampTime,
  startTogether,
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

/**
 * How long a playing room waits for a controller to come back before it
 * pauses. A stream that drops and reconnects (backoff starts at 2 s) must not
 * pause everyone.
 */
const ORPHAN_GRACE_MS = 15_000;

interface BusState {
  /** Keys the public ids in participant lists (see publicIdOf); new each process start. */
  idSecret?: Buffer;
  rooms: Map<string, RoomState>;
  orphanTimers?: Map<string, ReturnType<typeof setTimeout>>;
  /** The 60 s wait before control passes on from a creator who left (planOrphan). */
  handoverTimers?: Map<string, ReturnType<typeof setTimeout>>;
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
  const rows = asRows<{ user_id: string | null; guest_token: string | null; reason: string }>(
    db.prepare("SELECT user_id, guest_token, reason FROM party_controllers WHERE room_id = ?").all(roomId),
  );
  return {
    creatorUserId: room?.creator_user_id ?? null,
    userIds: rows.flatMap((r) => (r.user_id ? [r.user_id] : [])),
    guestTokens: rows.flatMap((r) => (r.guest_token ? [r.guest_token] : [])),
    // A person granted after inheriting has a 'granted' row: only those with no grant count as inherited.
    inheritedUserIds: rows.flatMap((r) =>
      r.user_id && r.reason === "inherited" && !rows.some((g) => g.user_id === r.user_id && g.reason === "granted") ? [r.user_id] : [],
    ),
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

/** The message a reply answers, if it is a message in this room. */
function replyTarget(roomId: string, messageId: string | null): PartyChatMessage["replyTo"] {
  if (!messageId) return null;
  const row = asRow<{ id: string; display_name: string; body: string }>(
    getDb().prepare("SELECT id, display_name, body FROM party_messages WHERE id = ? AND room_id = ?").get(messageId, roomId),
  );
  return row ? { id: row.id, displayName: row.display_name, excerpt: excerpt(row.body) } : null;
}

function saveMessage(roomId: string, identity: PartyIdentity, body: string, replyToId: string | null): PartyChatMessage {
  const id = randomUUID();
  const now = Date.now();
  const replyTo = replyTarget(roomId, replyToId);
  getDb()
    .prepare(
      `INSERT INTO party_messages (id, room_id, user_id, guest_token, display_name, body, created_at, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      roomId,
      identity.kind === "user" ? identity.id : null,
      identity.kind === "guest" ? identity.id : null,
      identity.displayName,
      body,
      now,
      replyTo?.id ?? null,
    );
  return { id, kind: identity.kind, displayName: identity.displayName, body, createdAt: now, replyTo, reactions: [] };
}

export function loadHistory(roomId: string): PartyChatMessage[] {
  const db = getDb();
  const rows = asRows<{
    id: string;
    user_id: string | null;
    display_name: string;
    body: string;
    created_at: number;
    reply_id: string | null;
    reply_name: string | null;
    reply_body: string | null;
  }>(
    db
      .prepare(
        `SELECT m.id, m.user_id, m.display_name, m.body, m.created_at,
                r.id AS reply_id, r.display_name AS reply_name, r.body AS reply_body
           FROM party_messages m
           LEFT JOIN party_messages r ON r.id = m.reply_to_id AND r.room_id = m.room_id
          WHERE m.room_id = ? ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(roomId, HISTORY_LIMIT),
  ).reverse();
  const reactionRows = asRows<{ message_id: string; emoji: string; display_name: string }>(
    db
      .prepare(
        `SELECT x.message_id, x.emoji, x.display_name FROM party_message_reactions x
           JOIN party_messages m ON m.id = x.message_id
          WHERE m.room_id = ? ORDER BY x.created_at`,
      )
      .all(roomId),
  );
  const reactionsFor = new Map<string, { emoji: string; displayName: string }[]>();
  for (const r of reactionRows) {
    const list = reactionsFor.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, displayName: r.display_name });
    reactionsFor.set(r.message_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    kind: r.user_id ? ("user" as const) : ("guest" as const),
    displayName: r.display_name,
    body: r.body,
    createdAt: r.created_at,
    replyTo: r.reply_id ? { id: r.reply_id, displayName: r.reply_name ?? "", excerpt: excerpt(r.reply_body ?? "") } : null,
    reactions: groupReactions(reactionsFor.get(r.id) ?? []),
  }));
}

/**
 * Adds this person's reaction to a message, or takes it back if they had
 * already reacted with that emoji. Everyone gets the message's new set.
 */
export function toggleReaction(roomId: string, identity: PartyIdentity, messageId: string, emoji: string): boolean {
  if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) return false;
  const db = getDb();
  const inRoom = asRow<{ n: number }>(
    db.prepare("SELECT COUNT(*) AS n FROM party_messages WHERE id = ? AND room_id = ?").get(messageId, roomId),
  );
  if (!inRoom?.n) return false;
  const reactor = `${identity.kind === "user" ? "u" : "g"}:${identity.id}`;
  const removed = db
    .prepare("DELETE FROM party_message_reactions WHERE message_id = ? AND reactor = ? AND emoji = ?")
    .run(messageId, reactor, emoji);
  if (Number(removed.changes) === 0) {
    db.prepare(
      "INSERT INTO party_message_reactions (message_id, reactor, display_name, emoji, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(messageId, reactor, identity.displayName, emoji, Date.now());
  }
  const reactions = groupReactions(
    asRows<{ emoji: string; display_name: string }>(
      db.prepare("SELECT emoji, display_name FROM party_message_reactions WHERE message_id = ? ORDER BY created_at").all(messageId),
    ).map((r) => ({ emoji: r.emoji, displayName: r.display_name })),
  );
  const room = bus().rooms.get(roomId);
  if (room) broadcast(room, { type: "reactions", messageId, reactions });
  return true;
}

/* ------------------------------------------------------------------ *
 * Membership — the room logic itself is in party-room.ts.
 * ------------------------------------------------------------------ */

/**
 * The id a participant is known by in the room's participant list. Never
 * the real id: a guest's real id is their guest-link token, which lets
 * whoever holds it in as them, and the list goes to everyone in the room.
 * A keyed hash, so it is stable for the life of the process (grant and
 * revoke name people by it) but cannot be turned back into the token.
 */
function publicIdOf(identity: Pick<PartyIdentity, "kind" | "id">): string {
  const state = bus();
  state.idSecret ??= randomBytes(32);
  return createHmac("sha256", state.idSecret).update(`${identity.kind}:${identity.id}`).digest("base64url").slice(0, 22);
}

export function broadcastParticipants(roomId: string): void {
  const room = bus().rooms.get(roomId);
  if (!room) return;
  const grants = roomGrants(roomId);
  broadcast(room, {
    type: "participants",
    list: participantList(
      room,
      (identity) => canControl(grants, identity),
      publicIdOf,
      Date.now(),
      (identity) => identity.kind === "user" && (grants.inheritedUserIds ?? []).includes(identity.id),
    ),
  });
}

/** Opens an event stream for one participant. Returns an unsubscribe function. */
/** The creator's name, for the chat lines about them leaving and coming back (they may not be here to ask). */
function creatorName(roomId: string): string {
  const row = asRow<{ username: string }>(
    getDb()
      .prepare("SELECT u.username FROM party_rooms r JOIN users u ON u.id = r.creator_user_id WHERE r.id = ?")
      .get(roomId),
  );
  return row?.username ?? "The host";
}

/** Control passes to `to` because the creator left (planOrphan). The film is not touched. */
function handOver(roomId: string, room: RoomState, to: PartyIdentity): void {
  getDb()
    .prepare("INSERT INTO party_controllers (room_id, user_id, granted_at, reason) VALUES (?, ?, ?, 'inherited')")
    .run(roomId, to.id, Date.now());
  room.handedOverWhileAway = true;
  postNotice(room, `${creatorName(roomId)} left; ${to.displayName} can now control playback`, Date.now());
  broadcastParticipants(roomId);
}

/**
 * After anyone joins, leaves, or gains or loses control. See planOrphan in
 * party-room.ts for the rule: with nobody watching who can control, control
 * passes on once the creator has been gone 60 s; only if there is nobody to
 * pass it to does a playing room pause, after a short grace period.
 */
function checkOrphaned(roomId: string): void {
  const state = bus();
  const pauseTimers = (state.orphanTimers ??= new Map());
  const handoverTimers = (state.handoverTimers ??= new Map());
  const room = state.rooms.get(roomId);
  const stop = (timers: Map<string, ReturnType<typeof setTimeout>>) => {
    clearTimeout(timers.get(roomId));
    timers.delete(roomId);
  };
  if (!room) {
    stop(pauseTimers);
    stop(handoverTimers);
    return;
  }
  const control = (identity: PartyMemberIdentity) => isController(roomId, identity as PartyIdentity);
  const plan = planOrphan(room, control, Date.now());

  if (plan.kind !== "pause") stop(pauseTimers);
  if (plan.kind !== "wait") stop(handoverTimers);

  if (plan.kind === "handover") {
    handOver(roomId, room, plan.to as PartyIdentity);
    checkOrphaned(roomId);
  } else if (plan.kind === "wait" && !handoverTimers.has(roomId)) {
    const timer = setTimeout(() => {
      handoverTimers.delete(roomId);
      checkOrphaned(roomId);
    }, Math.max(0, plan.at - Date.now()));
    timer.unref?.();
    handoverTimers.set(roomId, timer);
  } else if (plan.kind === "pause" && !pauseTimers.has(roomId)) {
    const timer = setTimeout(() => {
      pauseTimers.delete(roomId);
      const current = bus().rooms.get(roomId);
      if (current && planOrphan(current, control, Date.now()).kind === "pause") pauseOrphaned(current, Date.now());
    }, ORPHAN_GRACE_MS);
    timer.unref?.();
    pauseTimers.set(roomId, timer);
  }
}

export function joinRoom(
  roomId: string,
  identity: PartyIdentity,
  clientId: string | null,
  watching: boolean,
  send: (event: PartyEvent) => void,
): () => void {
  ensureSweep();
  const room = roomState(roomId);
  const member: Member = { identity, clientId, isCreator: isCreator(roomId, identity), watching, send };
  bus().emptySince.delete(roomId);

  send({ type: "you", id: publicIdOf(identity) });
  send({ type: "history", messages: loadHistory(roomId) });
  const now = Date.now();
  send({ type: "state", positionSeconds: currentPosition(room, now), paused: room.paused, at: now });
  addMember(room, member);
  if (creatorReturned(room, member)) {
    postNotice(room, `${identity.displayName} is back and shares control`, Date.now());
  }
  broadcastParticipants(roomId);

  checkOrphaned(roomId);

  return () => {
    removeMember(room, member);
    broadcastParticipants(roomId);
    checkOrphaned(roomId);
  };
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export const MAX_MESSAGE_CHARS = 1000;

export function postChat(
  roomId: string,
  identity: PartyIdentity,
  rawBody: string,
  replyToId: string | null = null,
): PartyChatMessage | null {
  const body = rawBody.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!body) return null;
  const message = saveMessage(roomId, identity, body, replyToId);
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
  const result = applySync(room, findOrigin(room, identity.id, clientId), identity, action, positionSeconds, at);
  if (result === "waiting" && room.pending) {
    // One slow screen cannot hold everyone: start without it after a while.
    const id = room.pending.id;
    const timer = setTimeout(() => {
      if (room.pending?.id === id) startTogether(room, Date.now());
    }, GROUP_START_TIMEOUT_MS);
    timer.unref?.();
  }
  return true;
}

/** A screen has buffered at the spot a "prepare" named; see markReady. */
export function postReady(
  roomId: string,
  identity: PartyIdentity,
  clientId: string | null,
  startId: string,
  rttMs: number,
): boolean {
  const room = bus().rooms.get(roomId);
  if (!room) return false;
  return markReady(room, findOrigin(room, identity.id, clientId), startId, rttMs, Date.now());
}

/** How often the participants list (with everyone's drift) is re-sent while reports come in. */
const DRIFT_BROADCAST_MS = 4000;
const lastDriftBroadcast = new Map<string, number>();

/**
 * Any watching stream's "my film is here", every few seconds — for the drift
 * shown beside each name, not for sync. Open to non-controllers: it moves
 * nothing.
 */
export function postReport(
  roomId: string,
  identity: PartyIdentity,
  clientId: string | null,
  positionSeconds: number,
  paused: boolean,
  sentAt: unknown,
): boolean {
  const room = bus().rooms.get(roomId);
  const origin = room ? findOrigin(room, identity.id, clientId) : undefined;
  if (!room || !origin) return false;
  const now = Date.now();
  origin.report = { positionSeconds, paused, at: stampTime(sentAt, now) };
  if (now - (lastDriftBroadcast.get(roomId) ?? 0) >= DRIFT_BROADCAST_MS) {
    lastDriftBroadcast.set(roomId, now);
    broadcastParticipants(roomId);
  }
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
  // targetId is the public id from the participant list, not a real id.
  const target = room ? [...room.members].find((m) => publicIdOf(m.identity) === targetId) : undefined;
  if (!target) return false;
  const realId = target.identity.id;

  const column = target.identity.kind === "user" ? "user_id" : "guest_token";
  if (grant) {
    // One row per person, recorded as the creator's grant (replacing an
    // inherited one: the creator has now chosen them).
    getDb().prepare(`DELETE FROM party_controllers WHERE room_id = ? AND ${column} = ?`).run(roomId, realId);
    getDb()
      .prepare(`INSERT INTO party_controllers (room_id, ${column}, granted_at, reason) VALUES (?, ?, ?, 'granted')`)
      .run(roomId, realId, Date.now());
  } else {
    getDb().prepare(`DELETE FROM party_controllers WHERE room_id = ? AND ${column} = ?`).run(roomId, realId);
    if (room) dropLeaderIf(room, realId);
  }
  checkOrphaned(roomId);
  if (room) {
    const name = target.identity.displayName;
    postNotice(room, grant ? `${identity.displayName} gave ${name} playback control` : `${identity.displayName} took back playback control from ${name}`, Date.now());
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
