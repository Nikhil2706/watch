import "server-only";

import { env } from "./env";
import { generateId, generateToken, sha256Hex } from "./crypto";
import { asRow, asRows, getDb, transaction } from "./db";
import { sendInviteEmail } from "./email";
import { validateEmail } from "./validation";

export interface InviteRow {
  id: string;
  token_hash: string;
  label: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
  email: string | null;
  langlois_mode: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreatedInvite {
  id: string;
  /** Plaintext token. Returned exactly once, here. Never persisted. */
  token: string;
  url: string;
  label: string | null;
  maxUses: number;
  expiresAt: number;
  email: string | null;
  langloisMode: boolean;
  /**
   * Only present when `input.email` was given. `true` means the email is
   * confirmed sent; `false` means the invite was still created (the link
   * above is always valid) but the email itself didn't go out — see
   * `emailError` for why, so the caller can fall back to sharing the link
   * by hand instead of assuming it already reached someone.
   */
  emailSent?: boolean;
  emailError?: string;
}

export async function createInvite(input: {
  label?: string | null;
  maxUses?: number;
  expiresInDays?: number;
  email?: string | null;
  langloisMode?: boolean;
}): Promise<CreatedInvite> {
  const maxUses = input.maxUses ?? env.defaultInviteMaxUses;
  const expiresInDays = input.expiresInDays ?? env.defaultInviteExpiryDays;

  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
    throw new InviteValidationError("max_uses must be an integer between 1 and 1000");
  }
  if (!Number.isFinite(expiresInDays) || expiresInDays <= 0 || expiresInDays > 3650) {
    throw new InviteValidationError("expires_in_days must be between 1 and 3650");
  }
  const email = input.email?.trim() ? validateEmail(input.email) : null;

  const now = Date.now();
  const id = generateId();
  const token = generateToken();
  const label = input.label?.trim() || null;
  const expiresAt = now + Math.round(expiresInDays * DAY_MS);

  const langloisMode = input.langloisMode ?? false;

  // Only the hash is written. There is no code path anywhere in this app that
  // can recover the plaintext afterwards — losing the link means issuing a new
  // invite, by design.
  getDb()
    .prepare(
      `INSERT INTO invites (id, token_hash, label, max_uses, use_count, expires_at, revoked_at, created_at, email, langlois_mode)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)`,
    )
    .run(id, sha256Hex(token), label, maxUses, expiresAt, now, email, langloisMode ? 1 : 0);

  const url = `${env.publicUrl}/invite/${token}`;
  const result: CreatedInvite = { id, token, url, label, maxUses, expiresAt, email, langloisMode };

  // Sending happens after the row is committed, and never rolls the invite
  // back on failure: a curator who typed the email wrong (or whose provider
  // is briefly down) should still get a valid link to copy and send by hand
  // — a working invite is the thing that actually matters, email is just a
  // convenience on top of it.
  if (email) {
    const sendResult = await sendInviteEmail({ to: email, url, label, expiresAt });
    result.emailSent = sendResult.sent;
    if (!sendResult.sent) result.emailError = sendResult.reason;
  }

  return result;
}

export class InviteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InviteValidationError";
  }
}

export interface InviteSummary {
  id: string;
  label: string | null;
  max_uses: number;
  use_count: number;
  remaining_uses: number;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  status: "active" | "revoked" | "expired" | "exhausted";
  redeemed_usernames: string[];
  email: string | null;
  langlois_mode: boolean;
}

export function listInvites(): InviteSummary[] {
  const now = Date.now();
  const rows = asRows<InviteRow>(
    getDb().prepare("SELECT * FROM invites ORDER BY created_at DESC").all(),
  );

  const usernameStatement = getDb().prepare(
    "SELECT username FROM users WHERE invited_by_invite_id = ? ORDER BY created_at",
  );

  return rows.map((row) => {
    const usernames = asRows<{ username: string }>(
      usernameStatement.all(row.id),
    ).map((u) => u.username);

    let status: InviteSummary["status"] = "active";
    if (row.revoked_at !== null) status = "revoked";
    else if (row.expires_at <= now) status = "expired";
    else if (row.use_count >= row.max_uses) status = "exhausted";

    return {
      id: row.id,
      label: row.label,
      max_uses: row.max_uses,
      use_count: row.use_count,
      remaining_uses: Math.max(0, row.max_uses - row.use_count),
      created_at: new Date(row.created_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      revoked_at: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
      status,
      redeemed_usernames: usernames,
      email: row.email,
      langlois_mode: row.langlois_mode === 1,
    };
  });
}

/** Marks an invite revoked. Idempotent; returns false if the id is unknown. */
export function revokeInvite(id: string): boolean {
  const result = getDb()
    .prepare("UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(Date.now(), id);

  if (Number(result.changes) > 0) return true;

  // Distinguish "already revoked" (success, idempotent) from "no such invite".
  const exists = getDb()
    .prepare("SELECT 1 AS found FROM invites WHERE id = ?")
    .get(id);
  return exists !== undefined;
}

/** Read-only status check, for rendering the redemption page before submit. */
export function peekInvite(
  token: string,
): { valid: true; label: string | null } | { valid: false; reason: string } {
  const row = asRow<InviteRow>(
    getDb()
      .prepare("SELECT * FROM invites WHERE token_hash = ?")
      .get(sha256Hex(token)),
  );

  if (!row) return { valid: false, reason: "This invite link is not valid." };
  if (row.revoked_at !== null) {
    return { valid: false, reason: "This invite has been revoked." };
  }
  if (row.expires_at <= Date.now()) {
    return { valid: false, reason: "This invite has expired." };
  }
  if (row.use_count >= row.max_uses) {
    return { valid: false, reason: "This invite has already been used." };
  }
  return { valid: true, label: row.label };
}

export type ClaimResult =
  | { ok: true; inviteId: string; langloisMode: boolean }
  | { ok: false; reason: string };

/**
 * Atomically consumes one use of an invite.
 *
 * THE TRANSACTION BOUNDARY IS HERE, AND IT IS DELIBERATELY NARROW.
 *
 * The check ("is this invite still usable?") and the act ("consume a use") are a
 * single conditional UPDATE inside one BEGIN IMMEDIATE transaction. That is what
 * makes a one-use invite genuinely one-use: two browsers submitting the same
 * link at the same instant cannot both read use_count = 0 and both proceed,
 * because the `use_count < max_uses` predicate is evaluated by SQLite while
 * holding the write lock. A read-then-write in application code would have a
 * race window here no amount of care could close.
 *
 * The Jellyfin API calls deliberately happen *outside* this transaction. Holding
 * the SQLite write lock across several seconds of HTTP round-trips would block
 * every other writer and could wedge the database if the process died
 * mid-request. Instead the invite use is claimed first, Jellyfin work happens
 * unlocked, and `releaseInviteClaim` gives the use back if that work fails.
 */
export function claimInvite(token: string): ClaimResult {
  const tokenHash = sha256Hex(token);
  const now = Date.now();

  return transaction((db) => {
    const claimed = db
      .prepare(
        `UPDATE invites
            SET use_count = use_count + 1
          WHERE token_hash = ?
            AND revoked_at IS NULL
            AND expires_at > ?
            AND use_count < max_uses`,
      )
      .run(tokenHash, now);

    if (Number(claimed.changes) === 1) {
      const row = asRow<{ id: string; langlois_mode: number }>(
        db.prepare("SELECT id, langlois_mode FROM invites WHERE token_hash = ?").get(tokenHash),
      );
      // The UPDATE matched, so the row exists; this is belt and braces.
      if (row) return { ok: true, inviteId: row.id, langloisMode: row.langlois_mode === 1 };
    }

    // Nothing was claimed. Work out why, for a useful error message. Still
    // inside the transaction, so the answer is consistent with the attempt.
    const row = asRow<InviteRow>(
      db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(tokenHash),
    );

    if (!row) return { ok: false, reason: "This invite link is not valid." };
    if (row.revoked_at !== null) {
      return { ok: false, reason: "This invite has been revoked." };
    }
    if (row.expires_at <= now) {
      return { ok: false, reason: "This invite has expired." };
    }
    return { ok: false, reason: "This invite has already been used." };
  });
}

/**
 * Compensating action for a claim whose Jellyfin work failed. Returns the use to
 * the pool so a transient Jellyfin outage does not silently burn a single-use
 * invite.
 */
export function releaseInviteClaim(inviteId: string): void {
  getDb()
    .prepare("UPDATE invites SET use_count = use_count - 1 WHERE id = ? AND use_count > 0")
    .run(inviteId);
}
