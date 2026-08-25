import "server-only";

import { cookieSecure, env } from "./env";
import { generateSessionId, generateId } from "./crypto";
import { asRow, asRows, getDb, transaction } from "./db";

/**
 * Opaque server-side sessions.
 *
 * WHY NOT A JWT: a JWT is valid until it expires and cannot be withdrawn. The
 * brief requires immediate revocation, and more importantly the session row is
 * where the Jellyfin access token lives. A JWT would have to either carry that
 * token to the browser — defeating the entire gateway — or be pointless.
 *
 * WHY THE JELLYFIN TOKEN NEVER LEAVES THE SERVER: it is a bearer credential for
 * Jellyfin's own API. Any client-side JavaScript that could read it could talk
 * to Jellyfin directly, bypassing this app's endpoint deny-list, its rate
 * limits, and its ability to revoke access. Keeping it in this row and
 * attaching it inside the /jf/* proxy is what makes this a gateway rather than
 * a login page. The browser only ever holds the opaque session id below, in an
 * httpOnly cookie it cannot read.
 */

export const SESSION_COOKIE = "jfg_session";

export interface SessionRow {
  id: string;
  user_id: string;
  jellyfin_token: string;
  jellyfin_device_id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  username: string;
  jellyfinUserId: string;
  jellyfinToken: string;
  jellyfinDeviceId: string;
  expiresAt: number;
  langloisMode: boolean;
  parentalControl: boolean;
}

interface JoinedRow extends SessionRow {
  username: string;
  jellyfin_user_id: string;
  langlois_mode: number;
  parental_control: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ttlMs(): number {
  return env.sessionTtlDays * DAY_MS;
}

/**
 * Creates the local user row and the session in one transaction.
 * Used by the redemption flow, where both must appear together or not at all.
 */
export function createUserAndSession(input: {
  jellyfinUserId: string;
  username: string;
  invitedByInviteId: string;
  jellyfinToken: string;
  jellyfinDeviceId: string;
  userAgent: string | null;
  ip: string | null;
  langloisMode?: boolean;
}): { sessionId: string; userId: string } {
  const now = Date.now();
  const userId = generateId();
  const sessionId = generateSessionId();

  transaction((db) => {
    db.prepare(
      `INSERT INTO users (id, jellyfin_user_id, username, invited_by_invite_id, created_at, last_seen_at, langlois_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      userId,
      input.jellyfinUserId,
      input.username,
      input.invitedByInviteId,
      now,
      now,
      input.langloisMode ? 1 : 0,
    );

    db.prepare(
      `INSERT INTO sessions (id, user_id, jellyfin_token, jellyfin_device_id, created_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      userId,
      input.jellyfinToken,
      input.jellyfinDeviceId,
      now,
      now + ttlMs(),
      input.userAgent,
      input.ip,
    );
  });

  return { sessionId, userId };
}

/**
 * Creates a session for an existing local user, upserting the user row so that
 * a Jellyfin account created out-of-band (or a database restored without it)
 * can still log in.
 */
export function createSessionForLogin(input: {
  jellyfinUserId: string;
  username: string;
  jellyfinToken: string;
  jellyfinDeviceId: string;
  userAgent: string | null;
  ip: string | null;
}): string {
  const now = Date.now();
  const sessionId = generateSessionId();

  transaction((db) => {
    const existing = asRow<{ id: string }>(
      db
        .prepare("SELECT id FROM users WHERE jellyfin_user_id = ?")
        .get(input.jellyfinUserId),
    );

    let userId: string;
    if (existing) {
      userId = existing.id;
      db.prepare(
        "UPDATE users SET last_seen_at = ?, username = ? WHERE id = ?",
      ).run(now, input.username, userId);
    } else {
      userId = generateId();
      db.prepare(
        `INSERT INTO users (id, jellyfin_user_id, username, invited_by_invite_id, created_at, last_seen_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).run(userId, input.jellyfinUserId, input.username, now, now);
    }

    db.prepare(
      `INSERT INTO sessions (id, user_id, jellyfin_token, jellyfin_device_id, created_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      userId,
      input.jellyfinToken,
      input.jellyfinDeviceId,
      now,
      now + ttlMs(),
      input.userAgent,
      input.ip,
    );
  });

  return sessionId;
}

/** Reads the session id out of the request's Cookie header. */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}

/**
 * Looks up a session and its user. Returns null for missing, unknown or expired
 * sessions — the caller cannot distinguish the three, which is deliberate.
 *
 * Expired rows are deleted on sight so a stale session cannot be resurrected by
 * a clock change.
 */
export function getSession(sessionId: string | null): ResolvedSession | null {
  if (!sessionId) return null;

  const row = asRow<JoinedRow>(
    getDb()
      .prepare(
        `SELECT s.*, u.username, u.jellyfin_user_id, u.langlois_mode, u.parental_control
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.id = ?`,
      )
      .get(sessionId),
  );

  if (!row) return null;

  if (row.expires_at <= Date.now()) {
    getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    return null;
  }

  return {
    sessionId: row.id,
    userId: row.user_id,
    username: row.username,
    jellyfinUserId: row.jellyfin_user_id,
    jellyfinToken: row.jellyfin_token,
    jellyfinDeviceId: row.jellyfin_device_id,
    expiresAt: row.expires_at,
    langloisMode: row.langlois_mode === 1,
    parentalControl: row.parental_control === 1,
  };
}

export function getSessionFromRequest(request: Request): ResolvedSession | null {
  return getSession(readSessionCookie(request));
}

/**
 * Sliding renewal, applied lazily.
 *
 * Renewing on literally every request would mean one SQLite write per HTTP
 * request — and a single video seek fires many Range requests through /jf/*.
 * Instead the row is only rewritten once SESSION_RENEW_AFTER_HOURS of the
 * lifetime has been consumed. The user-visible behaviour is identical (an
 * active session never expires); the write volume drops by orders of magnitude.
 *
 * Returns true when the cookie should be re-sent with a new Max-Age.
 */
export function touchSession(session: ResolvedSession): boolean {
  const now = Date.now();
  const renewThreshold = ttlMs() - env.sessionRenewAfterHours * 60 * 60 * 1000;

  if (session.expiresAt - now > renewThreshold) return false;

  const db = getDb();
  db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(
    now + ttlMs(),
    session.sessionId,
  );
  db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(
    now,
    session.userId,
  );
  return true;
}

export function destroySession(sessionId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function listSessions(): Array<
  Omit<SessionRow, "jellyfin_token"> & { username: string }
> {
  return asRows<Omit<SessionRow, "jellyfin_token"> & { username: string }>(
    getDb()
      .prepare(
        `SELECT s.id, s.user_id, s.jellyfin_device_id, s.created_at, s.expires_at,
                s.user_agent, s.ip, u.username
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          ORDER BY s.created_at DESC`,
      )
      .all(),
  );
}

/** Fetches a session's Jellyfin token so an admin revocation can also log it out upstream. */
export function getSessionForRevocation(
  sessionId: string,
): { jellyfinToken: string; jellyfinDeviceId: string } | null {
  const row = asRow<{ jellyfin_token: string; jellyfin_device_id: string }>(
    getDb()
      .prepare("SELECT jellyfin_token, jellyfin_device_id FROM sessions WHERE id = ?")
      .get(sessionId),
  );
  if (!row) return null;
  return {
    jellyfinToken: row.jellyfin_token,
    jellyfinDeviceId: row.jellyfin_device_id,
  };
}

/* ------------------------------------------------------------------ *
 * Cookie serialisation
 * ------------------------------------------------------------------ */

/**
 * `Set-Cookie` for a live session.
 *
 *  httpOnly — script cannot read it, so an XSS bug cannot exfiltrate the
 *             session (and therefore cannot reach the Jellyfin token).
 *  secure   — never sent over plain http in production.
 *  sameSite=lax — blocks cross-site POSTs from carrying the cookie, which is
 *             the CSRF defence for every mutating route here, while still
 *             letting an invite link opened from a chat app arrive logged in.
 *  path=/   — the cookie must also be sent to /jf/*, not just the app routes.
 */
export function sessionCookie(sessionId: string): string {
  const maxAge = Math.floor(ttlMs() / 1000);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (cookieSecure) parts.push("Secure");
  return parts.join("; ");
}
