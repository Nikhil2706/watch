import "server-only";

import { cookieSecure, env } from "./env";
import { generateSessionId, generateId } from "./crypto";
import { asRow, asRows, getDb, transaction } from "./db";
import { addDeviceAccount, parseDeviceAccounts, removeDeviceAccount, serializeDeviceAccounts } from "./device-accounts";

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

/** Every session signed in on this device, for switching (device-accounts.ts). */
export const ACCOUNTS_COOKIE = "jfg_accounts";

/** Set while a TV is in use; when it lapses, Home asks "Who's watching?" (middleware.ts). */
export const RECENT_COOKIE = "jfg_recent";

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
  /** Their own switch: leave what they have watched out of Home's rows and Browse. */
  hideWatched: boolean;
  /** May use /admin and /api/admin/* (users.is_admin, v59), unless the account is suspended. */
  isAdmin: boolean;
}

interface JoinedRow extends SessionRow {
  username: string;
  jellyfin_user_id: string;
  langlois_mode: number;
  parental_control: number;
  hide_watched: number;
  is_admin: number;
  suspended: number;
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
/** Thrown when a suspended account somehow gets past Jellyfin's own refusal. */
export class SuspendedAccountError extends Error {
  constructor() {
    super("This account's access has been withdrawn.");
    this.name = "SuspendedAccountError";
  }
}

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
    const existing = asRow<{ id: string; suspended: number }>(
      db
        .prepare("SELECT id, suspended FROM users WHERE jellyfin_user_id = ?")
        .get(input.jellyfinUserId),
    );

    /*
     * Second lock on the same door. Suspension sets Jellyfin's IsDisabled, so
     * a suspended account should never authenticate far enough to reach this
     * function at all — but "should never" is doing a lot of work there, and
     * the cost of being sure is one column already in hand. Without it, the
     * gate would happily mint a fresh session for someone whose access was
     * withdrawn, the moment anything upstream disagreed.
     */
    if (existing?.suspended === 1) throw new SuspendedAccountError();

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

/** One cookie's value out of the request's Cookie header. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value === "" ? null : decodeURIComponent(value);
  }
  return null;
}

/** Reads the session id out of the request's Cookie header. */
export function readSessionCookie(request: Request): string | null {
  return readCookie(request, SESSION_COOKIE);
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
        `SELECT s.*, u.username, u.jellyfin_user_id, u.langlois_mode, u.parental_control, u.hide_watched, u.is_admin, u.suspended
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
    hideWatched: row.hide_watched === 1,
    isAdmin: row.is_admin === 1 && row.suspended !== 1,
  };
}

export function getSessionFromRequest(request: Request): ResolvedSession | null {
  return getSession(readSessionCookie(request));
}

/* ------------------------------------------------------------------ *
 * Accounts saved on this device (device-accounts.ts)
 * ------------------------------------------------------------------ */

/**
 * The session ids saved on the device that sent this request, newest first,
 * with the active session included even if the list predates it (a device
 * signed in before switching existed has jfg_session and no list).
 */
export function readDeviceAccounts(request: Request): string[] {
  const saved = parseDeviceAccounts(readCookie(request, ACCOUNTS_COOKIE));
  const active = readSessionCookie(request);
  return active && !saved.includes(active) ? [...saved, active] : saved;
}

/**
 * The saved accounts that can still be switched to, resolved, newest first.
 * A session that has ended (signed out elsewhere, revoked, expired) is left
 * out; `ids` is the list to write back so the cookie forgets it too.
 */
export function resolveDeviceAccounts(saved: string[]): { accounts: ResolvedSession[]; ids: string[] } {
  const accounts: ResolvedSession[] = [];
  for (const id of saved) {
    const session = getSession(id);
    if (session && !accounts.some((a) => a.userId === session.userId)) accounts.push(session);
  }
  return { accounts, ids: accounts.map((a) => a.sessionId) };
}

/**
 * The cookies for a sign-in on this device: the session itself, and the
 * device's list with it added. Signing in never signs anyone else out here;
 * an earlier session of the same account is replaced in the list. Signing in
 * is also using the device: without the recent mark, the first Home after
 * someone was added on a TV asked "Who's watching?" of the person who had
 * just answered it.
 */
export function signInCookies(request: Request, sessionId: string): string[] {
  const userOf = (id: string) => asRow<{ user_id: string }>(getDb().prepare("SELECT user_id FROM sessions WHERE id = ?").get(id))?.user_id;
  const me = userOf(sessionId);
  const ids = addDeviceAccount(readDeviceAccounts(request), sessionId, (other) => me !== undefined && userOf(other) === me);
  return [sessionCookie(sessionId), accountsCookie(ids), recentCookie()];
}

/** The device's list after this session signs out here. */
export function signOutAccountsCookie(request: Request, sessionId: string): { cookie: string; remaining: number } {
  const ids = removeDeviceAccount(readDeviceAccounts(request), sessionId);
  return { cookie: accountsCookie(ids), remaining: ids.length };
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

/**
 * Every live session belonging to one user, with the Jellyfin token needed to
 * kill each one upstream too.
 *
 * Signing somebody out has to mean all of their devices, not the one the
 * curator happens to be looking at — a suspension that leaves a phone still
 * streaming is not a suspension.
 */
export function listSessionsForUser(
  userId: string,
): Array<{ id: string; jellyfinToken: string; jellyfinDeviceId: string }> {
  const rows = asRows<{ id: string; jellyfin_token: string; jellyfin_device_id: string }>(
    getDb()
      .prepare("SELECT id, jellyfin_token, jellyfin_device_id FROM sessions WHERE user_id = ?")
      .all(userId),
  );
  return rows.map((r) => ({
    id: r.id,
    jellyfinToken: r.jellyfin_token,
    jellyfinDeviceId: r.jellyfin_device_id,
  }));
}

/** Drops every session row for one user. Returns how many were live. */
export function destroySessionsForUser(userId: string): number {
  const result = getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
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

/** How long a TV counts as in use after the last page it opened. */
export const RECENT_SECONDS = 3 * 60 * 60;

/**
 * `Set-Cookie` marking this TV as in use. Not httpOnly-sensitive (it holds no
 * identity), but kept httpOnly like the rest; middleware renews it.
 */
export function recentCookie(): string {
  const parts = [`${RECENT_COOKIE}=1`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${RECENT_SECONDS}`];
  if (cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

/** Response headers carrying several Set-Cookie lines, which a plain object cannot. */
export function withCookies(base: Record<string, string>, cookies: string[]): Headers {
  const headers = new Headers(base);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return headers;
}

/**
 * `Set-Cookie` for the device's saved accounts; same flags as the session's.
 * It lasts as long as browsers allow (400 days) rather than one session's
 * TTL: each session renews itself as it is used, and the list must not lapse
 * under a TV used daily. It only names sessions, each checked on every read,
 * so outliving one grants nothing.
 */
export function accountsCookie(ids: string[]): string {
  const value = serializeDeviceAccounts(ids);
  const parts = [
    `${ACCOUNTS_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${value ? 400 * 24 * 60 * 60 : 0}`,
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
