import { requireAdmin } from "@/lib/admin-auth";
import { logout as jellyfinLogout } from "@/lib/jellyfin";
import { destroySession, getSessionForRevocation } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * DELETE /api/admin/sessions/:id
 *
 * Immediate revocation — this is the reason sessions are opaque rows rather
 * than JWTs. Deleting the row cuts off the /jf/* proxy on the very next
 * request, with no waiting for an expiry to elapse.
 *
 * The Jellyfin token is invalidated upstream too, so the credential is dead
 * even for anything that already holds it.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;

  const target = getSessionForRevocation(id);
  if (!target) {
    return Response.json(
      { error: "not_found", message: `No session with id ${id}.` },
      { status: 404, headers: NO_STORE },
    );
  }

  // Local row first: this is the part that must not fail. If Jellyfin is
  // unreachable the session is still dead as far as this app is concerned.
  destroySession(id);

  let jellyfinLoggedOut = true;
  try {
    await jellyfinLogout(target.jellyfinToken, target.jellyfinDeviceId);
  } catch (error) {
    jellyfinLoggedOut = false;
    console.warn("[admin/sessions] Jellyfin logout failed for revoked session:", error);
  }

  return Response.json(
    { id, revoked: true, jellyfin_token_invalidated: jellyfinLoggedOut },
    { headers: NO_STORE },
  );
}
