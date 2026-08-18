import { requireAdmin } from "@/lib/admin-auth";
import {
  createInvite,
  InviteValidationError,
  listInvites,
} from "@/lib/invites";
import {
  optionalBoolean,
  optionalInt,
  optionalString,
  readJsonBody,
  ValidationError,
} from "@/lib/validation";

// node:sqlite and node:crypto are unavailable on the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/invites
 * Body: { label?, max_uses?, expires_in_days?, email? }
 * -> { id, token, url, ..., email_sent? }
 *
 * The `token` field in this response is the only time the plaintext exists.
 * When `email` is given, the invite is emailed as part of this same request
 * — no separate "send" step. A failed send never fails the request itself;
 * `email_sent: false` + `email_error` tell the caller to fall back to
 * sharing `url` by hand.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);

    const invite = await createInvite({
      label: optionalString(body, "label") ?? null,
      maxUses: optionalInt(body, "max_uses"),
      expiresInDays: optionalInt(body, "expires_in_days"),
      email: optionalString(body, "email") ?? null,
      langloisMode: optionalBoolean(body, "langlois_mode"),
    });

    return Response.json(
      {
        id: invite.id,
        token: invite.token,
        url: invite.url,
        label: invite.label,
        max_uses: invite.maxUses,
        expires_at: new Date(invite.expiresAt).toISOString(),
        email: invite.email,
        langlois_mode: invite.langloisMode,
        email_sent: invite.emailSent,
        email_error: invite.emailError,
        note: "Save the url now. The token is hashed on storage and cannot be shown again.",
      },
      { status: 201, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ValidationError || error instanceof InviteValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/invites] create failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not create invite." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** GET /api/admin/invites -> every invite with its use count and status. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const invites = listInvites();
    return Response.json({ invites, count: invites.length }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/invites] list failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not list invites." },
      { status: 500, headers: NO_STORE },
    );
  }
}
