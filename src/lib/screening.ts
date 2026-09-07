import "server-only";

import { asRow, asRows, getDb, transaction } from "./db";
import { generateId, generateSessionId, generateToken, sha256Hex } from "./crypto";

/**
 * Screening Room: an expiring link that lets one person watch one film, with
 * no account and no library.
 *
 * Delivery is option B from the design — one shared Jellyfin service account,
 * many scoped screening sessions. Creating a screening is therefore a pure
 * SQLite write with no Jellyfin call at all, so it cannot fail halfway the way
 * redemption can, and cleanup is deleting rows rather than deleting accounts.
 *
 * The cost of sharing one account is that Jellyfin's own UserData would bleed
 * one stranger's resume position into another's, which is why progress is
 * tracked here in screening_progress instead.
 *
 * Scoping lives in screening-scope.ts and is an allow-list. Read the banner at
 * the top of that file before touching anything here.
 */

export const SCREENING_COOKIE = "screening_session";

/** Matches INVITE_DEFAULT_EXPIRY_DAYS — an unopened link dies after a week. */
export const SCREENING_DEFAULT_EXPIRY_DAYS = 7;
export const SCREENING_DEFAULT_WINDOW_HOURS = 48;

/**
 * Do not rip the last twenty minutes of a film away from someone. If a window
 * closes while they are watching, they get this much grace, hard-capped.
 */
export const SCREENING_GRACE_MS = 30 * 60 * 1000;

export type WindowStartsOn = "open" | "play";

interface ScreeningRow {
  id: string;
  token_hash: string;
  created_by_user_id: string;
  recipient_label: string | null;
  recipient_email: string | null;
  message: string | null;
  expires_at: number;
  window_hours: number;
  window_starts_on: string;
  window_started_at: number | null;
  max_devices: number;
  max_concurrent: number;
  stamp_name: number;
  device_attempts: number;
  first_opened_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export interface ScreeningItem {
  position: number;
  jellyfinItemId: string;
  itemPath: string | null;
  imdbId: string | null;
  title: string;
}

export interface CreateScreeningInput {
  createdByUserId: string;
  items: Array<{ jellyfinItemId: string; itemPath?: string | null; imdbId?: string | null; title: string }>;
  recipientLabel?: string | null;
  recipientEmail?: string | null;
  message?: string | null;
  expiryDays?: number;
  windowHours?: number;
  windowStartsOn?: WindowStartsOn;
  maxDevices?: number;
  maxConcurrent?: number;
  stampName?: boolean;
}

/**
 * Creates a screening and returns the plaintext token ONCE.
 *
 * The token is never persisted — only its SHA-256, exactly as invites do it —
 * so a stolen database yields no usable screening links and a lost link cannot
 * be recovered, only reissued.
 */
export function createScreening(input: CreateScreeningInput): { id: string; token: string } {
  if (input.items.length === 0) throw new Error("a screening needs at least one item");

  const id = generateId();
  const token = generateToken();
  const now = Date.now();
  const expiresAt = now + (input.expiryDays ?? SCREENING_DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000;

  transaction((db) => {
    db.prepare(
      `INSERT INTO screenings (
         id, token_hash, created_by_user_id, recipient_label, recipient_email, message,
         expires_at, window_hours, window_starts_on, max_devices, max_concurrent,
         stamp_name, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sha256Hex(token),
      input.createdByUserId,
      input.recipientLabel ?? null,
      input.recipientEmail ?? null,
      input.message ?? null,
      expiresAt,
      input.windowHours ?? SCREENING_DEFAULT_WINDOW_HOURS,
      input.windowStartsOn ?? "open",
      input.maxDevices ?? 2,
      input.maxConcurrent ?? 1,
      input.stampName ? 1 : 0,
      now,
    );

    input.items.forEach((item, position) => {
      db.prepare(
        `INSERT INTO screening_items (screening_id, position, jellyfin_item_id, item_path, imdb_id, title)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, position, item.jellyfinItemId, item.itemPath ?? null, item.imdbId ?? null, item.title);
    });
  });

  return { id, token };
}

export type ScreeningRefusal =
  | "invalid"
  | "revoked"
  | "expired"
  | "window_closed"
  | "too_many_devices";

/**
 * Why a link did not work, phrased for an honest recipient.
 *
 * Follows peekInvite(): "expired" and "revoked" are distinguished from "not
 * valid" because the first two are useful to someone who was legitimately sent
 * the link, and give an attacker nothing they did not already know.
 */
export function refusalMessage(reason: ScreeningRefusal): string {
  switch (reason) {
    case "revoked":
      return "This screening has been withdrawn.";
    case "expired":
      return "This screening link has expired.";
    case "window_closed":
      return "This screening has ended.";
    case "too_many_devices":
      return "This screening has already been opened on too many devices.";
    default:
      return "This link is not valid.";
  }
}

export interface ClaimResult {
  ok: boolean;
  sessionId?: string;
  screeningId?: string;
  reason?: ScreeningRefusal;
}

/**
 * Exchange a token for a device slot and a session.
 *
 * The device slot is claimed with one conditional UPDATE inside a transaction,
 * copying claimInvite() deliberately: two browsers opening the same link at the
 * same instant must not both take the last slot.
 */
export function claimScreeningDevice(
  token: string,
  context: { userAgent?: string | null; ip?: string | null },
): ClaimResult {
  const tokenHash = sha256Hex(token);
  const now = Date.now();

  return transaction((db) => {
    const row = asRow<ScreeningRow>(
      db.prepare("SELECT * FROM screenings WHERE token_hash = ?").get(tokenHash),
    );
    if (!row) return { ok: false, reason: "invalid" as const };
    if (row.revoked_at !== null) return { ok: false, reason: "revoked" as const };

    // The link expiry only applies until it has been opened; after that the
    // viewing window is what governs. A screener sent on Friday and opened on
    // Wednesday should still give the recipient their full window.
    if (row.first_opened_at === null && row.expires_at <= now) {
      return { ok: false, reason: "expired" as const };
    }

    const started = row.window_started_at;
    if (started !== null && now > started + row.window_hours * 60 * 60 * 1000 + SCREENING_GRACE_MS) {
      return { ok: false, reason: "window_closed" as const };
    }

    const devices = asRow<{ n: number }>(
      db.prepare("SELECT COUNT(*) AS n FROM screening_sessions WHERE screening_id = ?").get(row.id),
    );

    // Every attempt is counted, including refused ones — that count is how the
    // curator sees a link has been passed around.
    db.prepare("UPDATE screenings SET device_attempts = device_attempts + 1 WHERE id = ?").run(row.id);

    if ((devices?.n ?? 0) >= row.max_devices) {
      return { ok: false, reason: "too_many_devices" as const };
    }

    const sessionId = generateSessionId();
    db.prepare(
      `INSERT INTO screening_sessions
         (id, screening_id, jellyfin_device_id, display_name, created_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      row.id,
      // Its own device id, so Jellyfin's session list keeps two screenings on
      // the shared account apart the way it keeps two browsers of one member apart.
      `screening-${sessionId.slice(0, 16)}`,
      row.recipient_label,
      now,
      now,
      context.userAgent ?? null,
      context.ip ?? null,
    );

    const patch: string[] = [];
    if (row.first_opened_at === null) patch.push("first_opened_at = :now");
    if (row.window_started_at === null && row.window_starts_on === "open") {
      patch.push("window_started_at = :now");
    }
    if (patch.length > 0) {
      db.prepare(`UPDATE screenings SET ${patch.join(", ")} WHERE id = :id`).run({ now, id: row.id });
    }

    return { ok: true, sessionId, screeningId: row.id };
  });
}

export interface ResolvedScreening {
  sessionId: string;
  screeningId: string;
  displayName: string | null;
  jellyfinDeviceId: string;
  items: ScreeningItem[];
  message: string | null;
  recipientLabel: string | null;
  stampName: boolean;
  /** When the viewing window closes, or null if it has not started. */
  endsAt: number | null;
  windowStartsOn: WindowStartsOn;
  revoked: boolean;
}

/** Resolve the opaque cookie value to a live screening, or null. */
export function resolveScreeningSession(sessionId: string): ResolvedScreening | null {
  const row = asRow<ScreeningRow & { session_id: string; display_name: string | null; jellyfin_device_id: string }>(
    getDb()
      .prepare(
        `SELECT s.*, ss.id AS session_id, ss.display_name, ss.jellyfin_device_id
           FROM screening_sessions ss
           JOIN screenings s ON s.id = ss.screening_id
          WHERE ss.id = ?`,
      )
      .get(sessionId),
  );
  if (!row) return null;

  const items = asRows<{
    position: number;
    jellyfin_item_id: string;
    item_path: string | null;
    imdb_id: string | null;
    title: string;
  }>(
    getDb()
      .prepare("SELECT * FROM screening_items WHERE screening_id = ? ORDER BY position")
      .all(row.id),
  ).map((i) => ({
    position: i.position,
    jellyfinItemId: i.jellyfin_item_id,
    itemPath: i.item_path,
    imdbId: i.imdb_id,
    title: i.title,
  }));

  return {
    sessionId: row.session_id,
    screeningId: row.id,
    displayName: row.display_name,
    jellyfinDeviceId: row.jellyfin_device_id,
    items,
    message: row.message,
    recipientLabel: row.recipient_label,
    stampName: row.stamp_name === 1,
    endsAt:
      row.window_started_at === null
        ? null
        : row.window_started_at + row.window_hours * 60 * 60 * 1000,
    windowStartsOn: row.window_starts_on === "play" ? "play" : "open",
    revoked: row.revoked_at !== null,
  };
}

export type ScreeningLiveState =
  | { state: "active"; endsAt: number | null; msRemaining: number | null }
  | { state: "grace"; endsAt: number; msRemaining: number }
  | { state: "ended"; reason: ScreeningRefusal };

/**
 * Is this screening still watchable right now?
 *
 * Checked per request, which is what makes a revoke kill a stream in progress
 * within one HLS segment. That is the intended behaviour, not a bug.
 */
export function screeningState(resolved: ResolvedScreening, now = Date.now()): ScreeningLiveState {
  if (resolved.revoked) return { state: "ended", reason: "revoked" };
  if (resolved.endsAt === null) return { state: "active", endsAt: null, msRemaining: null };

  if (now <= resolved.endsAt) {
    return { state: "active", endsAt: resolved.endsAt, msRemaining: resolved.endsAt - now };
  }
  if (now <= resolved.endsAt + SCREENING_GRACE_MS) {
    return { state: "grace", endsAt: resolved.endsAt, msRemaining: resolved.endsAt + SCREENING_GRACE_MS - now };
  }
  return { state: "ended", reason: "window_closed" };
}

/** Starts the clock for a 'play' window, once, on first actual playback. */
export function markScreeningPlayStarted(screeningId: string): void {
  getDb()
    .prepare(
      `UPDATE screenings
          SET window_started_at = ?
        WHERE id = ? AND window_started_at IS NULL AND window_starts_on = 'play'`,
    )
    .run(Date.now(), screeningId);
}

export function touchScreeningSession(sessionId: string): void {
  getDb().prepare("UPDATE screening_sessions SET last_seen_at = ? WHERE id = ?").run(Date.now(), sessionId);
}

export function setScreeningProgress(sessionId: string, itemId: string, positionTicks: number): void {
  getDb()
    .prepare(
      `INSERT INTO screening_progress (screening_session_id, jellyfin_item_id, position_ticks, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(screening_session_id, jellyfin_item_id)
       DO UPDATE SET position_ticks = excluded.position_ticks, updated_at = excluded.updated_at`,
    )
    .run(sessionId, itemId, Math.max(0, Math.floor(positionTicks)), Date.now());
}

export function getScreeningProgress(sessionId: string, itemId: string): number {
  const row = asRow<{ position_ticks: number }>(
    getDb()
      .prepare(
        "SELECT position_ticks FROM screening_progress WHERE screening_session_id = ? AND jellyfin_item_id = ?",
      )
      .get(sessionId, itemId),
  );
  return row?.position_ticks ?? 0;
}

export function revokeScreening(id: string): void {
  getDb().prepare("UPDATE screenings SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
}

export interface ScreeningSummary {
  id: string;
  recipientLabel: string | null;
  titles: string[];
  createdAt: number;
  expiresAt: number;
  firstOpenedAt: number | null;
  endsAt: number | null;
  revoked: boolean;
  deviceCount: number;
  deviceAttempts: number;
  /** Names people typed. A courtesy label, never a claim about who they are. */
  openedBy: string[];
}

export function listScreenings(): ScreeningSummary[] {
  const rows = asRows<ScreeningRow>(
    getDb().prepare("SELECT * FROM screenings ORDER BY created_at DESC LIMIT 200").all(),
  );
  return rows.map((row) => {
    const titles = asRows<{ title: string }>(
      getDb().prepare("SELECT title FROM screening_items WHERE screening_id = ? ORDER BY position").all(row.id),
    ).map((t) => t.title);
    const sessions = asRows<{ display_name: string | null }>(
      getDb().prepare("SELECT display_name FROM screening_sessions WHERE screening_id = ?").all(row.id),
    );
    return {
      id: row.id,
      recipientLabel: row.recipient_label,
      titles,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      firstOpenedAt: row.first_opened_at,
      endsAt:
        row.window_started_at === null ? null : row.window_started_at + row.window_hours * 60 * 60 * 1000,
      revoked: row.revoked_at !== null,
      deviceCount: sessions.length,
      deviceAttempts: row.device_attempts,
      openedBy: sessions.map((s) => s.display_name).filter((n): n is string => !!n),
    };
  });
}

export function nameScreeningSession(sessionId: string, displayName: string): void {
  getDb()
    .prepare("UPDATE screening_sessions SET display_name = ? WHERE id = ?")
    .run(displayName.slice(0, 60).trim() || "Guest", sessionId);
}

/**
 * Delete screenings well past their end.
 *
 * Without this the database slowly becomes a permanent record of who was sent
 * what — which is exactly the thing the viewing-metrics decision was about.
 * Sessions and progress cascade.
 */
export function purgeOldScreenings(olderThanDays = 30): number {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const result = getDb()
    .prepare(
      `DELETE FROM screenings
        WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
           OR (first_opened_at IS NULL AND expires_at < ?)
           OR (window_started_at IS NOT NULL AND window_started_at + window_hours * 3600000 < ?)`,
    )
    .run(cutoff, cutoff, cutoff);
  return Number(result.changes);
}
