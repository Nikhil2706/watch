import "server-only";

import { generateId } from "./crypto";
import { asRow, asRows, getDb } from "./db";

/**
 * Watch-party rooms and guest links. Chat messages themselves aren't read
 * here — the `party` realtime process owns writing them (it's the thing
 * actually receiving them over the socket) and reads them back for a
 * rejoin's history; this module only covers what the gate app's own pages
 * and API routes need: creating a room, minting guest links, and listing
 * rooms for the home page banner and notifications.
 */

export interface PartyRoom {
  id: string;
  jellyfinId: string;
  filmTitle: string;
  filmHref: string;
  creatorUserId: string;
  scheduledAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

interface PartyRoomRow {
  id: string;
  jellyfin_id: string;
  film_title: string;
  film_href: string;
  creator_user_id: string;
  scheduled_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

function fromRow(r: PartyRoomRow): PartyRoom {
  return {
    id: r.id,
    jellyfinId: r.jellyfin_id,
    filmTitle: r.film_title,
    filmHref: r.film_href,
    creatorUserId: r.creator_user_id,
    scheduledAt: r.scheduled_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    createdAt: r.created_at,
  };
}

export interface CreatePartyInput {
  jellyfinId: string;
  filmTitle: string;
  filmHref: string;
  creatorUserId: string;
  /** Omit for an instant party — it goes live (started_at set) immediately. */
  scheduledAt?: number;
}

export function createPartyRoom(input: CreatePartyInput): PartyRoom {
  const now = Date.now();
  const id = generateId();
  const scheduledAt = input.scheduledAt ?? null;
  // An instant party (no scheduledAt) starts immediately; a scheduled one
  // waits for runPartyScheduleTick() to flip it live at scheduledAt.
  const startedAt = scheduledAt ? null : now;

  getDb()
    .prepare(
      `INSERT INTO party_rooms (id, jellyfin_id, film_title, film_href, creator_user_id, scheduled_at, started_at, ended_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(id, input.jellyfinId, input.filmTitle, input.filmHref, input.creatorUserId, scheduledAt, startedAt, now);

  return {
    id,
    jellyfinId: input.jellyfinId,
    filmTitle: input.filmTitle,
    filmHref: input.filmHref,
    creatorUserId: input.creatorUserId,
    scheduledAt,
    startedAt,
    endedAt: null,
    createdAt: now,
  };
}

export function getPartyRoom(roomId: string): PartyRoom | null {
  const row = asRow<PartyRoomRow>(getDb().prepare("SELECT * FROM party_rooms WHERE id = ?").get(roomId));
  return row ? fromRow(row) : null;
}

/** Started, not yet ended — what the home page banner and the "join" flow both need. */
export function listLiveParties(): PartyRoom[] {
  return asRows<PartyRoomRow>(
    getDb()
      .prepare("SELECT * FROM party_rooms WHERE started_at IS NOT NULL AND ended_at IS NULL ORDER BY started_at DESC")
      .all(),
  ).map(fromRow);
}

/** Scheduled, not yet started — the home page's "coming up" list. */
export function listUpcomingParties(): PartyRoom[] {
  return asRows<PartyRoomRow>(
    getDb()
      .prepare("SELECT * FROM party_rooms WHERE started_at IS NULL AND ended_at IS NULL AND scheduled_at IS NOT NULL ORDER BY scheduled_at ASC")
      .all(),
  ).map(fromRow);
}

/** Only the creator may end their own party — checked here, not just left to the caller. */
export function endPartyRoom(roomId: string, requesterUserId: string): boolean {
  const result = getDb()
    .prepare("UPDATE party_rooms SET ended_at = ? WHERE id = ? AND creator_user_id = ? AND ended_at IS NULL")
    .run(Date.now(), roomId, requesterUserId);
  return Number(result.changes) > 0;
}

export interface PartyGuestLink {
  token: string;
  roomId: string;
  label: string;
  createdAt: number;
}

/** label defaults to "Guest N" (N = however many guest links this room already has, 1-based) if the creator doesn't type a real name. */
export function createGuestLink(roomId: string, label?: string): PartyGuestLink {
  const db = getDb();
  const token = generateId();
  const now = Date.now();
  const resolvedLabel =
    label?.trim() ||
    `Guest ${(asRow<{ n: number }>(db.prepare("SELECT COUNT(*) AS n FROM party_guest_links WHERE room_id = ?").get(roomId))?.n ?? 0) + 1}`;

  db.prepare("INSERT INTO party_guest_links (token, room_id, label, created_at) VALUES (?, ?, ?, ?)").run(
    token,
    roomId,
    resolvedLabel,
    now,
  );

  return { token, roomId, label: resolvedLabel, createdAt: now };
}

export function listGuestLinks(roomId: string): PartyGuestLink[] {
  return asRows<{ token: string; room_id: string; label: string; created_at: number }>(
    getDb().prepare("SELECT * FROM party_guest_links WHERE room_id = ? ORDER BY created_at ASC").all(roomId),
  ).map((r) => ({ token: r.token, roomId: r.room_id, label: r.label, createdAt: r.created_at }));
}

export function getGuestLink(token: string): PartyGuestLink | null {
  const row = asRow<{ token: string; room_id: string; label: string; created_at: number }>(
    getDb().prepare("SELECT * FROM party_guest_links WHERE token = ?").get(token),
  );
  return row ? { token: row.token, roomId: row.room_id, label: row.label, createdAt: row.created_at } : null;
}
