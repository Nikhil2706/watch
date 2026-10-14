/**
 * The in-memory half of a watch party room: who is connected, where playback
 * is, and who fans out to whom. Split out of party-bus.ts so it can be tested
 * without the database — permissions come in as a callback, and the clock as
 * an argument. No server-only import; nothing here is a secret.
 */

export interface PartyMemberIdentity {
  kind: "user" | "guest";
  id: string;
  displayName: string;
}

export interface PartyChatMessage {
  id: string;
  /** "system": a line the room writes itself (who paused, who seeked). Not stored; gone after a reload. */
  kind: "user" | "guest" | "system";
  displayName: string;
  body: string;
  createdAt: number;
}

export interface PartyParticipant {
  id: string;
  kind: "user" | "guest";
  displayName: string;
  isController: boolean;
  /**
   * How far this person's film is from the room's, in seconds (+ ahead,
   * − behind), from the furthest-out of their screens. null: no screen
   * playing to compare (chat only, paused, or not reported yet).
   */
  driftSeconds: number | null;
}

export type PartySyncAction = "play" | "pause" | "seek";

/**
 * Every position carries `at`: the server time (ms) it was true at. A
 * position is only right at that moment, so clients carry it forward by its
 * age (party-sync.ts, targetPosition) rather than using it as sent.
 */
export type PartyEvent =
  | { type: "history"; messages: PartyChatMessage[] }
  | { type: "state"; positionSeconds: number; paused: boolean; at: number }
  | { type: "participants"; list: PartyParticipant[] }
  | { type: "chat"; message: PartyChatMessage }
  | { type: "sync"; action: PartySyncAction; positionSeconds: number; paused: boolean; at: number; by: string }
  /** The leader's position while playing, every few seconds, so followers can correct drift. */
  | { type: "position"; positionSeconds: number; at: number }
  /** The one stream that sends heartbeats; null when nobody leads yet (any controller may claim it). */
  | { type: "leader"; clientId: string | null }
  /** The room moved more than JUMP_UNDO_SECONDS: where it was, so a controller can take it back. */
  | { type: "jumped"; from: number; to: number; by: string }
  | { type: "ended" };

export interface Member {
  identity: PartyMemberIdentity;
  /**
   * One per open stream (a tab, the TV, a phone), chosen by the client. Two
   * devices on the same account are the same identity, so the identity alone
   * cannot say which stream an action came from.
   */
  clientId: string | null;
  /** The room's creator: leads the heartbeat when no other controller has acted. */
  isCreator: boolean;
  /**
   * This stream has a player (the room page), not just the chat (a chat tab,
   * a phone used for chat, a guest). Only these can press play, wait to start
   * together, or drift.
   */
  watching: boolean;
  /** Where this stream last said its film was (every few seconds, while it has the film open). */
  report?: { positionSeconds: number; paused: boolean; at: number };
  send: (event: PartyEvent) => void;
}

export interface RoomState {
  members: Set<Member>;
  positionSeconds: number;
  paused: boolean;
  /** Wall-clock time positionSeconds was last known accurate, for extrapolating "now" between syncs. */
  updatedAt: number;
  /**
   * The one stream that sends heartbeats: the creator's, or whoever last
   * played, paused or seeked. Only its heartbeats move the room, so two
   * controllers cannot drag everyone back and forth between their two
   * slightly different positions. Changes are announced (a "leader" event) so
   * every other controller knows to stay quiet.
   */
  leader: Member | null;
}

/**
 * A move bigger than this is a jump worth being able to undo — one stray
 * press on a TV remote's seek or a slip on the seek bar. Taken from SyncTube's
 * "flashback", which remembers the spot before any jump over 30 s.
 */
export const JUMP_UNDO_SECONDS = 30;

/** 1:02:13, or 4:05 under an hour. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** What a play/pause/seek reads as in the chat. */
export function syncNotice(action: PartySyncAction, positionSeconds: number, by: string): string {
  const at = formatClock(positionSeconds);
  if (action === "play") return `${by} played from ${at}`;
  if (action === "pause") return `${by} paused at ${at}`;
  return `${by} jumped to ${at}`;
}

/**
 * Tells the whole room something happened, as a line in the chat. Who
 * paused, who jumped: on 2026-10-14 nobody could tell which screen had done
 * what. Ephemeral — party_messages needs a user or guest behind every row.
 */
export function postNotice(room: RoomState, text: string, now: number): void {
  broadcast(room, {
    type: "chat",
    message: { id: `sys-${globalThis.crypto.randomUUID()}`, kind: "system", displayName: "", body: text, createdAt: now },
  });
}

export function createRoom(now: number): RoomState {
  return { members: new Set(), positionSeconds: 0, paused: true, updatedAt: now, leader: null };
}

export function currentPosition(room: RoomState, now: number): number {
  if (room.paused) return room.positionSeconds;
  return room.positionSeconds + (now - room.updatedAt) / 1000;
}

/**
 * When a position was true, by the server's clock. A client says when it
 * measured (its own estimate of server time, which leaves out the upload
 * delay); anything implausible — in the future, or older than a few seconds —
 * falls back to the moment it arrived.
 */
export function stampTime(sentAt: unknown, now: number): number {
  if (typeof sentAt !== "number" || !Number.isFinite(sentAt)) return now;
  if (sentAt > now + 1000 || sentAt < now - 5000) return now;
  return Math.min(sentAt, now);
}

/** Client ids are opaque, but they end up as Map keys and in logs, so only a plain token shape is accepted. */
export function cleanClientId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null;
}

/**
 * The stream an action came from: the one with this client id, else (an old
 * client that sends none) the first stream for that identity.
 */
export function findOrigin(room: RoomState, identityId: string, clientId: string | null): Member | undefined {
  const members = [...room.members].filter((m) => m.identity.id === identityId);
  return (clientId ? members.find((m) => m.clientId === clientId) : undefined) ?? members[0];
}

export function broadcast(room: RoomState, event: PartyEvent, except?: Member): void {
  for (const member of room.members) {
    if (member === except) continue;
    try {
      member.send(event);
    } catch {
      // One dead stream must not stop the rest of the room from being told.
    }
  }
}

/** Names the heartbeat source, and tells the room when that changes. */
export function setLeader(room: RoomState, member: Member | null): void {
  if (room.leader === member) return;
  room.leader = member;
  broadcast(room, { type: "leader", clientId: member?.clientId ?? null });
}

/** The creator's stream if one is here, else nobody: the next controller to send a heartbeat claims it. */
export function fallbackLeader(room: RoomState, except?: Member): Member | null {
  return [...room.members].find((m) => m.isCreator && m !== except) ?? null;
}

/** A new stream: told who leads, and the creator's first stream leads if nobody has acted yet. */
export function addMember(room: RoomState, member: Member): void {
  room.members.add(member);
  if (!room.leader && member.isCreator) setLeader(room, member);
  else member.send({ type: "leader", clientId: room.leader?.clientId ?? null });
}

export function removeMember(room: RoomState, member: Member): void {
  room.members.delete(member);
  if (room.leader === member) setLeader(room, fallbackLeader(room));
}

/** Control taken away from someone: if they led, the lead goes back to the creator. */
export function dropLeaderIf(room: RoomState, identityId: string): void {
  if (room.leader?.identity.id === identityId) setLeader(room, fallbackLeader(room, room.leader));
}

/**
 * Play, pause or seek from a controller. The position always travels with
 * the action, so a pause lands everyone on the same frame and a play starts
 * everyone from it. Everyone except the stream that did it is told: echoing a
 * seek back at its sender makes that player fight itself — but every other
 * stream is, including the same person's other device.
 */
export function applySync(
  room: RoomState,
  origin: Member | undefined,
  by: PartyMemberIdentity,
  action: PartySyncAction,
  positionSeconds: number,
  at: number,
): void {
  const before = currentPosition(room, at);
  room.positionSeconds = positionSeconds;
  // A seek keeps whatever play state the room had.
  if (action !== "seek") room.paused = action === "pause";
  room.updatedAt = at;
  if (origin) setLeader(room, origin);
  broadcast(
    room,
    { type: "sync", action, positionSeconds, paused: room.paused, at, by: by.displayName },
    origin,
  );
  postNotice(room, syncNotice(action, positionSeconds, by.displayName), at);
  // Everyone hears it, the sender included: the stray press was usually theirs.
  if (Math.abs(positionSeconds - before) > JUMP_UNDO_SECONDS) {
    broadcast(room, { type: "jumped", from: before, to: positionSeconds, by: by.displayName });
  }
}

/**
 * The heartbeat: a controller's periodic "I am here" while playing. Accepted
 * only from the leader, or from any controller's stream when there is none
 * (the first one heard then leads). Ignored while the room is paused: a heartbeat that
 * arrives just after a pause must not set the room playing again.
 */
export function applyHeartbeat(
  room: RoomState,
  origin: Member | undefined,
  positionSeconds: number,
  at: number,
): boolean {
  if (!origin || room.paused) return false;
  if (room.leader && room.leader !== origin && room.members.has(room.leader)) return false;
  setLeader(room, origin);
  room.positionSeconds = positionSeconds;
  room.updatedAt = at;
  broadcast(room, { type: "position", positionSeconds, at }, origin);
  return true;
}

/**
 * Someone here could press play or pause: a controller with the film open.
 * With nobody like that, a playing room carries on with nobody steering it.
 */
export function controllerWatching(room: RoomState, isController: (identity: PartyMemberIdentity) => boolean): boolean {
  return [...room.members].some((m) => m.watching && isController(m.identity));
}

/**
 * The last controller left (or lost control) while the room played: it
 * pauses where it is, so nobody watches on alone and has to be found again.
 * Taken from SyncTube, which pauses when its leader disconnects.
 */
export function pauseOrphaned(room: RoomState, now: number): boolean {
  if (room.paused) return false;
  room.positionSeconds = currentPosition(room, now);
  room.paused = true;
  room.updatedAt = now;
  broadcast(room, { type: "sync", action: "pause", positionSeconds: room.positionSeconds, paused: true, at: now, by: "" });
  postNotice(room, `Paused at ${formatClock(room.positionSeconds)}: nobody who can control playback is watching`, now);
  return true;
}

/** Reports older than this say nothing about now (the stream stopped reporting). */
const REPORT_STALE_MS = 15_000;

/**
 * How far one stream's film is from the room's right now, to a tenth of a
 * second. Taken from WatchParty, which shows every viewer's offset beside
 * their name. Only while both are playing: a paused screen in a playing room
 * is "paused", not "behind by a growing number".
 */
export function memberDrift(member: Member, room: RoomState, now: number): number | null {
  const report = member.report;
  if (!report || room.paused || report.paused || now - report.at > REPORT_STALE_MS) return null;
  const theirs = report.positionSeconds + (now - report.at) / 1000;
  return Math.round((theirs - currentPosition(room, now)) * 10) / 10;
}

/** One entry per person, however many screens they have open; drift from the furthest-out screen. */
export function participantList(
  room: RoomState,
  isController: (identity: PartyMemberIdentity) => boolean,
  now = Date.now(),
): PartyParticipant[] {
  const byId = new Map<string, PartyParticipant>();
  for (const member of room.members) {
    const drift = memberDrift(member, room, now);
    const existing = byId.get(member.identity.id);
    if (existing) {
      if (drift !== null && (existing.driftSeconds === null || Math.abs(drift) > Math.abs(existing.driftSeconds))) {
        existing.driftSeconds = drift;
      }
      continue;
    }
    byId.set(member.identity.id, {
      id: member.identity.id,
      kind: member.identity.kind,
      displayName: member.identity.displayName,
      isController: isController(member.identity),
      driftSeconds: drift,
    });
  }
  return [...byId.values()];
}

export interface PartyGrants {
  creatorUserId: string | null;
  /** user ids and guest tokens named in party_controllers for the room. */
  userIds: readonly string[];
  guestTokens: readonly string[];
}

/** The creator always controls playback; anyone else only while named in party_controllers. */
export function canControl(grants: PartyGrants, identity: Pick<PartyMemberIdentity, "kind" | "id">): boolean {
  if (identity.kind === "user") return identity.id === grants.creatorUserId || grants.userIds.includes(identity.id);
  return grants.guestTokens.includes(identity.id);
}
