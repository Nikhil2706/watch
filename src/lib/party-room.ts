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

export type PartySyncAction = "play" | "pause" | "seek";

export type PartyEvent =
  | { type: "history"; messages: PartyChatMessage[] }
  | { type: "state"; positionSeconds: number; paused: boolean }
  | { type: "participants"; list: PartyParticipant[] }
  | { type: "chat"; message: PartyChatMessage }
  | { type: "sync"; action: PartySyncAction; positionSeconds: number; by: string }
  /** The lead controller's position while playing, every few seconds, so followers can correct drift. */
  | { type: "position"; positionSeconds: number }
  | { type: "ended" };

export interface Member {
  identity: PartyMemberIdentity;
  /**
   * One per open stream (a tab, the TV, a phone), chosen by the client. Two
   * devices on the same account are the same identity, so the identity alone
   * cannot say which stream an action came from.
   */
  clientId: string | null;
  send: (event: PartyEvent) => void;
}

export interface RoomState {
  members: Set<Member>;
  positionSeconds: number;
  paused: boolean;
  /** Wall-clock time positionSeconds was last known accurate, for extrapolating "now" between syncs. */
  updatedAt: number;
  /**
   * The stream whose clock the room follows: whoever last played, paused or
   * seeked. Only its heartbeats move the room, so two controllers cannot
   * drag everyone back and forth between their two slightly different
   * positions.
   */
  leader: Member | null;
}

export function createRoom(now: number): RoomState {
  return { members: new Set(), positionSeconds: 0, paused: true, updatedAt: now, leader: null };
}

export function currentPosition(room: RoomState, now: number): number {
  if (room.paused) return room.positionSeconds;
  return room.positionSeconds + (now - room.updatedAt) / 1000;
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

export function removeMember(room: RoomState, member: Member): void {
  room.members.delete(member);
  if (room.leader === member) room.leader = null;
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
  now: number,
): void {
  room.positionSeconds = positionSeconds;
  // A seek keeps whatever play state the room had.
  if (action !== "seek") room.paused = action === "pause";
  room.updatedAt = now;
  if (origin) room.leader = origin;
  broadcast(room, { type: "sync", action, positionSeconds, by: by.displayName }, origin);
}

/**
 * A controller's periodic "I am here" while playing. Accepted only from the
 * leader, or from any controller's stream when there is none (the leader left,
 * or nobody has acted yet). Ignored while the room is paused: a heartbeat that
 * arrives just after a pause must not set the room playing again.
 */
export function applyHeartbeat(
  room: RoomState,
  origin: Member | undefined,
  positionSeconds: number,
  now: number,
): boolean {
  if (!origin || room.paused) return false;
  if (room.leader && room.leader !== origin && room.members.has(room.leader)) return false;
  room.leader = origin;
  room.positionSeconds = positionSeconds;
  room.updatedAt = now;
  broadcast(room, { type: "position", positionSeconds }, origin);
  return true;
}

/** One entry per person, however many screens they have open. */
export function participantList(
  room: RoomState,
  isController: (identity: PartyMemberIdentity) => boolean,
): PartyParticipant[] {
  const byId = new Map<string, PartyParticipant>();
  for (const member of room.members) {
    if (byId.has(member.identity.id)) continue;
    byId.set(member.identity.id, {
      id: member.identity.id,
      kind: member.identity.kind,
      displayName: member.identity.displayName,
      isController: isController(member.identity),
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
