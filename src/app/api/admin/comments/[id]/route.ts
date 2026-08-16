import { requireAdmin } from "@/lib/admin-auth";
import { adminDeleteComment } from "@/lib/community";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * DELETE /api/admin/comments/{id}
 *
 * Curator moderation override — no ownership check, unlike DELETE
 * /api/comments/{id}. Not wired into curator.html yet; callable directly
 * for the rare case (see PROJECT_KNOWLEDGE.md's Community section for the
 * standing note that a real dashboard view is a flagged follow-up).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;

  const removed = adminDeleteComment(id);
  if (!removed) {
    return Response.json({ error: "not_found", message: "No such comment." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
