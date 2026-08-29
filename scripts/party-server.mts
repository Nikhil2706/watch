#!/usr/bin/env node
/**
 * Watch-party realtime service — chat + playback sync over WebSocket.
 *
 *   node --experimental-strip-types scripts/party-server.mts
 *
 * A separate process from the gate app, same shape as media-worker.mjs:
 * its own container (docker-compose.yml's `party` service), reading and
 * writing the SAME SQLite file (safe under WAL, same reasoning as that
 * worker's own comment). See DESIGN-watch-party.md for why this is a
 * standalone service rather than a custom Next.js server — in short,
 * `next build` with `output: "standalone"` regenerates server.js on every
 * build, so anything needing WebSocket upgrades has to live outside it.
 *
 * Not wired into docker-compose.yml as a *running* service by default in
 * this pass — see that file's own comment on the `party` block. This
 * script is complete and startable on its own for testing:
 *
 *   DATABASE_PATH=./data/jellyfin-gate.db PARTY_PORT=4001 \
 *     node --experimental-strip-types scripts/party-server.mts
 *
 * ---------------------------------------------------------------------------
 * PROTOCOL (client <-> server, JSON text frames)
 *
 * Connect:  wss://<host>/ws/party?room=<roomId>
 *           Auth is cookie-based, same cookies the gate app already sets:
 *           jfg_session (a real account) or jfg_pg_<roomId> (a guest link,
 *           see src/lib/party-identity.ts) — whichever is present and
 *           valid. Neither present/valid -> connection is closed
 *           immediately with code 4401.
 *
 * Server -> client, sent once right after connecting:
 *   {type:"history", messages: ChatMessage[]}
 *   {type:"state", positionSeconds, paused}   -- extrapolated to "now"
 *   {type:"participants", list: Participant[]}
 *
 * Server -> client, ongoing:
 *   {type:"chat", message: ChatMessage}
 *   {type:"sync", action, positionSeconds, by}
 *   {type:"participants", list: Participant[]}
 *   {type:"ended"}   -- party is over (creator ended it, or the 15-minute
 *                        empty-room sweep did); socket is closed right after
 *
 * Client -> server:
 *   {type:"chat", body: string}
 *   {type:"sync", action:"play"|"pause"|"seek", positionSeconds: number}
 *   {type:"grant", targetId: string}    -- creator only
 *   {type:"revoke", targetId: string}   -- creator only
 *   {type:"end"}                        -- creator only, ends the party now
 * ---------------------------------------------------------------------------
 */

import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { WebSocketServer, type WebSocket } from "ws";

// -----------------------------------------------------------------------
// Database — a direct connection, not src/lib/db.ts: that module imports
// "server-only", which throws outside a Next.js server build on purpose.
// Same PRAGMAs as db.ts's openDatabase() for the same reasons given there.
// -----------------------------------------------------------------------

function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH ?? "./data/jellyfin-gate.db";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

const dbPath = resolveDatabasePath();
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

function asRow<T>(result: unknown): T | undefined {
  return result as T | undefined;
}
function asRows<T>(result: unknown): T[] {
  return result as T[];
}

// -----------------------------------------------------------------------
// Identity — mirrors getSession()/resolvePartyIdentity() in the gate app,
// duplicated rather than imported (this process has no access to the
// Next.js module graph, and the query is a few lines).
// -----------------------------------------------------------------------

interface Identity {
  kind: "user" | "guest";
  id: string;
  displayName: string;
}

function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    map.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return map;
}

function resolveIdentity(cookies: Map<string, string>, roomId: string): Identity | null {
  const sessionId = cookies.get("jfg_session");
  if (sessionId) {
    const row = asRow<{ user_id: string; username: string; expires_at: number }>(
      db
        .prepare(
          `SELECT s.user_id, u.username, s.expires_at
             FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id = ?`,
        )
        .get(sessionId),
    );
    if (row && row.expires_at > Date.now()) {
      return { kind: "user", id: row.user_id, displayName: row.username };
    }
  }

  const guestToken = cookies.get(`jfg_pg_${roomId}`);
  if (guestToken) {
    const row = asRow<{ token: string; room_id: string; label: string }>(
      db.prepare("SELECT * FROM party_guest_links WHERE token = ?").get(guestToken),
    );
    if (row && row.room_id === roomId) {
      return { kind: "guest", id: row.token, displayName: row.label };
    }
  }

  return null;
}

function isCreator(roomId: string, identity: Identity): boolean {
  if (identity.kind !== "user") return false;
  const row = asRow<{ creator_user_id: string }>(
    db.prepare("SELECT creator_user_id FROM party_rooms WHERE id = ?").get(roomId),
  );
  return row?.creator_user_id === identity.id;
}

function isController(roomId: string, identity: Identity): boolean {
  if (isCreator(roomId, identity)) return true;
  const column = identity.kind === "user" ? "user_id" : "guest_token";
  const row = asRow<{ n: number }>(
    db
      .prepare(`SELECT COUNT(*) AS n FROM party_controllers WHERE room_id = ? AND ${column} = ?`)
      .get(roomId, identity.id),
  );
  return (row?.n ?? 0) > 0;
}

// -----------------------------------------------------------------------
// Chat persistence
// -----------------------------------------------------------------------

interface ChatMessage {
  id: string;
  kind: "user" | "guest";
  displayName: string;
  body: string;
  createdAt: number;
}

const MAX_MESSAGE_CHARS = 1000;
const HISTORY_LIMIT = 100;

function saveMessage(roomId: string, identity: Identity, body: string): ChatMessage {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO party_messages (id, room_id, user_id, guest_token, display_name, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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

function loadHistory(roomId: string): ChatMessage[] {
  const rows = asRows<{ id: string; user_id: string | null; display_name: string; body: string; created_at: number }>(
    db
      .prepare(
        `SELECT id, user_id, display_name, body, created_at FROM party_messages
          WHERE room_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(roomId, HISTORY_LIMIT),
  );
  return rows
    .reverse()
    .map((r) => ({
      id: r.id,
      kind: r.user_id ? ("user" as const) : ("guest" as const),
      displayName: r.display_name,
      body: r.body,
      createdAt: r.created_at,
    }));
}

// -----------------------------------------------------------------------
// Live room state — connections and playback position are process memory
// only (see DESIGN-watch-party.md: a `party` container restart legitimately
// ending live parties is an acceptable trade at this scale). Chat history
// and control grants are the only things that need to survive a restart,
// and those are already in SQLite above.
// -----------------------------------------------------------------------

interface Connection {
  socket: WebSocket;
  identity: Identity;
}

interface RoomState {
  connections: Set<Connection>;
  positionSeconds: number;
  paused: boolean;
  /** Wall-clock time positionSeconds was last known accurate, for extrapolating "now" between sync broadcasts. */
  updatedAt: number;
}

const rooms = new Map<string, RoomState>();

function roomState(roomId: string): RoomState {
  let state = rooms.get(roomId);
  if (!state) {
    state = { connections: new Set(), positionSeconds: 0, paused: true, updatedAt: Date.now() };
    rooms.set(roomId, state);
  }
  return state;
}

function currentPosition(state: RoomState): number {
  if (state.paused) return state.positionSeconds;
  return state.positionSeconds + (Date.now() - state.updatedAt) / 1000;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(roomId: string, payload: unknown, exclude?: WebSocket): void {
  const state = rooms.get(roomId);
  if (!state) return;
  for (const conn of state.connections) {
    if (conn.socket !== exclude) send(conn.socket, payload);
  }
}

function participantList(roomId: string): Array<{ id: string; kind: string; displayName: string; isController: boolean }> {
  const state = rooms.get(roomId);
  if (!state) return [];
  // De-duplicated by identity id: the same person with two tabs open shows
  // once in the roster, even though they hold two live connections.
  const byId = new Map<string, { id: string; kind: string; displayName: string; isController: boolean }>();
  for (const conn of state.connections) {
    byId.set(conn.identity.id, {
      id: conn.identity.id,
      kind: conn.identity.kind,
      displayName: conn.identity.displayName,
      isController: isController(roomId, conn.identity),
    });
  }
  return [...byId.values()];
}

function broadcastParticipants(roomId: string): void {
  broadcast(roomId, { type: "participants", list: participantList(roomId) });
}

/**
 * Ends a party right now: marks it over in the DB (idempotent — the WHERE
 * clause makes a second call a no-op), tells anyone still connected, and
 * drops their sockets so a stale tab can't keep syncing playback against a
 * room nobody considers live anymore. Shared by the creator's explicit
 * "end party" action and the empty-room sweep below, so both paths behave
 * identically instead of drifting apart.
 */
function endRoom(roomId: string): void {
  db.prepare("UPDATE party_rooms SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(Date.now(), roomId);
  broadcast(roomId, { type: "ended" });
  const state = rooms.get(roomId);
  if (state) {
    for (const conn of state.connections) conn.socket.close(4000, "party_ended");
  }
  rooms.delete(roomId);
  emptySince.delete(roomId);
}

// -----------------------------------------------------------------------
// Auto-end sweep — a party nobody is in for 15+ minutes gets ended
// automatically instead of staying "live" forever (there was previously no
// cleanup path at all: the last disconnect only dropped the in-memory
// RoomState, never touched party_rooms.ended_at).
//
// emptySince is tracked independently of `rooms`, and on a timer rather
// than a per-room disconnect timeout, because a room can be "empty" from
// this process's point of view without this process ever having seen a
// connection for it — e.g. right after a restart, looking at a room that
// was abandoned days ago. In that case emptySince starts counting from
// "the first sweep that observed it empty", not from the true abandonment
// time, so an already-abandoned room takes up to one more sweep interval
// to end after a restart rather than ending instantly. That's an accepted
// trade for not needing a persisted "last active" column just for this.
// -----------------------------------------------------------------------

const EMPTY_TIMEOUT_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const emptySince = new Map<string, number>();

function sweepEmptyRooms(): void {
  const liveRooms = asRows<{ id: string }>(
    db.prepare("SELECT id FROM party_rooms WHERE started_at IS NOT NULL AND ended_at IS NULL").all(),
  );
  const liveIds = new Set(liveRooms.map((r) => r.id));

  for (const roomId of liveIds) {
    const hasConnections = (rooms.get(roomId)?.connections.size ?? 0) > 0;
    if (hasConnections) {
      emptySince.delete(roomId);
      continue;
    }
    const since = emptySince.get(roomId);
    if (since === undefined) {
      emptySince.set(roomId, Date.now());
    } else if (Date.now() - since >= EMPTY_TIMEOUT_MS) {
      console.log(`[party] auto-ending room ${roomId} (empty ${Math.round((Date.now() - since) / 60000)}min)`);
      endRoom(roomId);
    }
  }

  for (const roomId of emptySince.keys()) {
    if (!liveIds.has(roomId)) emptySince.delete(roomId);
  }

  // Rooms ended somewhere other than here — the creator pressing "End watch
  // party", which goes over HTTP to the gate (see
  // src/app/api/party/[roomId]/route.ts) because /ws/party is not routed in
  // production and a socket-only end button cannot be pressed at all.
  //
  // The database is the shared channel between the two processes, so this is
  // where an external end becomes visible. Without it those participants keep
  // a live-looking room open indefinitely: nothing tells them, and the next
  // reconnect would 404 with no explanation.
  for (const roomId of [...rooms.keys()]) {
    if (liveIds.has(roomId)) continue;
    const state = rooms.get(roomId);
    if (!state || state.connections.size === 0) {
      rooms.delete(roomId);
      continue;
    }
    console.log(`[party] room ${roomId} was ended elsewhere; closing ${state.connections.size} connection(s)`);
    broadcast(roomId, { type: "ended" });
    for (const conn of state.connections) conn.socket.close(4000, "party_ended");
    rooms.delete(roomId);
    emptySince.delete(roomId);
  }
}

// -----------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------

const PORT = Number(process.env.PARTY_PORT ?? 4001);

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("jellyfin-gate party server\n");
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://internal");
  if (url.pathname !== "/ws/party") {
    socket.destroy();
    return;
  }
  const roomId = url.searchParams.get("room");
  if (!roomId) {
    socket.destroy();
    return;
  }

  const cookies = parseCookies(request.headers.cookie);
  const identity = resolveIdentity(cookies, roomId);
  if (!identity) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const room = asRow<{ id: string; ended_at: number | null }>(
    db.prepare("SELECT id, ended_at FROM party_rooms WHERE id = ?").get(roomId),
  );
  if (!room || room.ended_at !== null) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    handleConnection(ws, roomId, identity);
  });
});

/**
 * Called directly from handleUpgrade's callback rather than through
 * wss.on("connection", ...) — @types/ws types that event's callback as
 * (socket, request), and this needs to hand off the roomId/identity this
 * upgrade already resolved instead. A plain function call is simpler than
 * fighting the EventEmitter's typed overload for a one-shot dispatch.
 */
function handleConnection(socket: WebSocket, roomId: string, identity: Identity): void {
  const state = roomState(roomId);
  const conn: Connection = { socket, identity };
  state.connections.add(conn);

  send(socket, { type: "history", messages: loadHistory(roomId) });
  send(socket, { type: "state", positionSeconds: currentPosition(state), paused: state.paused });
  broadcastParticipants(roomId);

  socket.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "chat") {
      const body = typeof msg.body === "string" ? msg.body.trim().slice(0, MAX_MESSAGE_CHARS) : "";
      if (!body) return;
      const message = saveMessage(roomId, identity, body);
      broadcast(roomId, { type: "chat", message });
      return;
    }

    if (msg.type === "sync") {
      if (!isController(roomId, identity)) return;
      const action = msg.action;
      const positionSeconds = typeof msg.positionSeconds === "number" ? msg.positionSeconds : state.positionSeconds;
      if (action !== "play" && action !== "pause" && action !== "seek") return;
      state.positionSeconds = positionSeconds;
      state.paused = action === "pause";
      state.updatedAt = Date.now();
      broadcast(roomId, { type: "sync", action, positionSeconds, by: identity.displayName }, socket);
      return;
    }

    if (msg.type === "grant" || msg.type === "revoke") {
      if (!isCreator(roomId, identity)) return;
      const targetId = typeof msg.targetId === "string" ? msg.targetId : null;
      if (!targetId) return;
      const target = [...state.connections].find((c) => c.identity.id === targetId);
      if (!target) return;
      const column = target.identity.kind === "user" ? "user_id" : "guest_token";
      if (msg.type === "grant") {
        db.prepare(
          `INSERT INTO party_controllers (room_id, ${column}, granted_at) VALUES (?, ?, ?)`,
        ).run(roomId, targetId, Date.now());
      } else {
        db.prepare(`DELETE FROM party_controllers WHERE room_id = ? AND ${column} = ?`).run(roomId, targetId);
      }
      broadcastParticipants(roomId);
      return;
    }

    if (msg.type === "end") {
      if (!isCreator(roomId, identity)) return;
      endRoom(roomId);
      return;
    }
  });

  socket.on("close", () => {
    state.connections.delete(conn);
    broadcastParticipants(roomId);
    if (state.connections.size === 0) rooms.delete(roomId);
  });
}

httpServer.listen(PORT, () => {
  console.log(`[party] listening on :${PORT} (db: ${dbPath})`);
});

setInterval(sweepEmptyRooms, SWEEP_INTERVAL_MS);
