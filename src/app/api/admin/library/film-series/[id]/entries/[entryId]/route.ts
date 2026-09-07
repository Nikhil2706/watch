import { requireAdmin } from "@/lib/admin-auth";
import { removeSeriesEntry } from "@/lib/scraping/film-series";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** DELETE /api/admin/library/film-series/{id}/entries/{entryId} — closes the position gap behind it. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; entryId: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id, entryId } = await params;

  const removed = removeSeriesEntry(id, entryId);
  if (!removed) {
    return Response.json({ error: "not_found", message: "No such entry." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
