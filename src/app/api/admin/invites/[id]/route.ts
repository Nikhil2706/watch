import { requireAdmin } from "@/lib/admin-auth";
import { revokeInvite } from "@/lib/invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * DELETE /api/admin/invites/:id
 *
 * Revokes rather than deletes: the row is kept so that `users.invited_by_invite_id`
 * still resolves and you can answer "who let this account in?" after the fact.
 * Idempotent — revoking twice is a 200, not an error.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;

  try {
    const found = revokeInvite(id);
    if (!found) {
      return Response.json(
        { error: "not_found", message: `No invite with id ${id}.` },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ id, revoked: true }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/invites] revoke failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not revoke invite." },
      { status: 500, headers: NO_STORE },
    );
  }
}
