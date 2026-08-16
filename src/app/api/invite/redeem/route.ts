import { logEvent } from "@/lib/events";
import { getClientIp, getUserAgent } from "@/lib/ip";
import { claimInvite, releaseInviteClaim } from "@/lib/invites";
import {
  applyRestrictedPolicy,
  authenticateByName,
  createUser,
  deleteUser,
  generateDeviceId,
  JellyfinError,
  setUserPassword,
} from "@/lib/jellyfin";
import {
  checkRateLimit,
  rateLimitHeaders,
  REDEEM_LIMIT,
  refundRateLimit,
} from "@/lib/ratelimit";
import { createUserAndSession, sessionCookie } from "@/lib/session";
import {
  readJsonBody,
  validatePassword,
  validateUsername,
  ValidationError,
} from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/invite/redeem  { token, username, password }
 *
 * Creates a real Jellyfin account and logs the new user in.
 *
 * ---------------------------------------------------------------------------
 * ON THE TRANSACTION BOUNDARY
 *
 * The brief asks for all six steps inside "a single database transaction". Two
 * of those steps are HTTP calls to Jellyfin, and a SQLite transaction cannot
 * span them safely: `node:sqlite` is synchronous, so an `await` inside a
 * transaction holds the write lock across seconds of network I/O, blocking
 * every other writer and risking a wedged database if the process dies. A
 * rollback also cannot undo a created Jellyfin user — which is why the brief
 * separately asks for that user to be deleted on failure.
 *
 * So the atomicity is placed where it actually protects something:
 *
 *   1. CLAIM   — one conditional UPDATE in one transaction consumes an invite
 *                use. This is the only genuine race in the flow (two people
 *                opening the same single-use link at once) and it is closed.
 *   2. WORK    — Jellyfin calls, unlocked.
 *   3. COMMIT  — a second short transaction writes the user row and session
 *                together.
 *   4. COMPENSATE — if step 2 or 3 fails, the Jellyfin user is deleted and the
 *                invite use is handed back.
 *
 * The observable guarantee the brief wanted is preserved: either the account,
 * the session and the consumed use all exist, or none of them do.
 * ---------------------------------------------------------------------------
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);

  const limit = checkRateLimit(REDEEM_LIMIT, ip);
  if (!limit.allowed) {
    return Response.json(
      {
        error: "rate_limited",
        message: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
      },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(REDEEM_LIMIT, limit) } },
    );
  }

  let token: string;
  let username: string;
  let password: string;
  try {
    const body = await readJsonBody(request);
    if (typeof body.token !== "string" || body.token.trim() === "") {
      throw new ValidationError("Invite token is required.");
    }
    token = body.token.trim();
    username = validateUsername(body.username);
    password = validatePassword(body.password);
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : "Invalid request.";
    return Response.json(
      { error: "invalid_request", message },
      { status: 400, headers: NO_STORE },
    );
  }

  // --- 1. CLAIM ------------------------------------------------------------
  const claim = claimInvite(token);
  if (!claim.ok) {
    return Response.json(
      { error: "invalid_invite", message: claim.reason },
      { status: 400, headers: NO_STORE },
    );
  }

  // From here on, every failure path must release the claim.
  let jellyfinUserId: string | null = null;

  try {
    // --- 2. WORK ----------------------------------------------------------
    const created = await createUser(username);
    if (!created?.Id) {
      throw new JellyfinError("Jellyfin did not return a user id.", 502, "");
    }
    jellyfinUserId = created.Id;

    // The account exists but has no password for this brief window. It is not
    // usable in that state: the restricted policy has not been applied yet and
    // Jellyfin is not exposed to the internet.
    await setUserPassword(jellyfinUserId, password);

    // Step 3 of the brief. If this throws, the catch below deletes the user
    // rather than leaving an account with default (unrestricted) permissions.
    await applyRestrictedPolicy(jellyfinUserId);

    // Log the new user in through the normal path so the token in the session
    // row is a real user token, not the admin key.
    const deviceId = generateDeviceId();
    const auth = await authenticateByName(username, password, deviceId);
    if (!auth?.AccessToken) {
      throw new JellyfinError("Jellyfin did not return an access token.", 502, "");
    }

    // --- 3. COMMIT --------------------------------------------------------
    const { sessionId } = createUserAndSession({
      jellyfinUserId,
      username: auth.User?.Name ?? username,
      invitedByInviteId: claim.inviteId,
      jellyfinToken: auth.AccessToken,
      jellyfinDeviceId: deviceId,
      userAgent: getUserAgent(request),
      ip,
    });

    // A successful redemption should not count against the limiter — someone
    // handed several invites shouldn't lock themselves out by using them.
    // Failed attempts still accumulate.
    refundRateLimit(REDEEM_LIMIT, ip);

    return Response.json(
      { ok: true, username, redirect: "/" },
      { status: 201, headers: { ...NO_STORE, "Set-Cookie": sessionCookie(sessionId) } },
    );
  } catch (error) {
    // --- 4. COMPENSATE ----------------------------------------------------
    if (jellyfinUserId) {
      try {
        await deleteUser(jellyfinUserId);
      } catch (cleanupError) {
        // Loud, because this is the one case that leaves real mess behind: a
        // Jellyfin account with no local user row. The README says to check for
        // these in Jellyfin's dashboard if this ever appears in the log.
        console.error(
          `[invite/redeem] ORPHANED JELLYFIN USER ${jellyfinUserId} (${username}) — ` +
            "automatic cleanup failed, delete it manually in the Jellyfin dashboard.",
          cleanupError,
        );
        logEvent({
          category: "internal_api",
          severity: "critical",
          source: "invite_redeem",
          message: `Orphaned Jellyfin user ${jellyfinUserId} (${username}) — cleanup failed`,
          detail: { jellyfinUserId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) },
          username,
        });
      }
    }
    releaseInviteClaim(claim.inviteId);

    if (error instanceof JellyfinError) {
      console.error(
        `[invite/redeem] Jellyfin ${error.status}: ${error.message} ${error.body}`,
      );

      if (error.status === 0) {
        logEvent({
          category: "internal_api",
          severity: "error",
          source: "invite_redeem",
          message: "Jellyfin unreachable during invite redemption",
          detail: { error: error.message },
          username,
        });
        return Response.json(
          { error: "upstream_unavailable", message: "The media server is not responding. Your invite has not been used — try again shortly." },
          { status: 502, headers: NO_STORE },
        );
      }
      if (error.status === 400 || error.status === 409) {
        // Overwhelmingly the "username already exists" case — routine, not logged.
        return Response.json(
          { error: "username_taken", message: "That username is not available. Pick another." },
          { status: 409, headers: NO_STORE },
        );
      }
      logEvent({
        category: "internal_api",
        severity: "error",
        source: "invite_redeem",
        message: `Jellyfin rejected invite redemption (${error.status})`,
        detail: { status: error.status, body: error.body },
        username,
      });
      return Response.json(
        { error: "upstream_error", message: "The media server rejected the request. Your invite has not been used." },
        { status: 502, headers: NO_STORE },
      );
    }

    console.error("[invite/redeem] failed:", error);
    logEvent({
      category: "internal_api",
      severity: "error",
      source: "invite_redeem",
      message: "Invite redemption failed",
      detail: { error: error instanceof Error ? error.message : String(error) },
      username,
    });
    return Response.json(
      { error: "internal_error", message: "Could not complete signup. Your invite has not been used." },
      { status: 500, headers: NO_STORE },
    );
  }
}
