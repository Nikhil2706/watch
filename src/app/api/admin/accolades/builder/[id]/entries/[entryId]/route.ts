import { requireAdmin } from "@/lib/admin-auth";
import { deleteCuratorAccoladeEntry } from "@/lib/scraping/curator-accolades";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** DELETE /api/admin/accolades/builder/{id}/entries/{entryId} */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { entryId } = await params;
  const removed = deleteCuratorAccoladeEntry(entryId);
  if (!removed) {
    return Response.json({ error: "not_found", message: "No such slot." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
