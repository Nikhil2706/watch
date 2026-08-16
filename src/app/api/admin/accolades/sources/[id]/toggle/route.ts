import { requireAdmin } from "@/lib/admin-auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/accolades/sources/{id}/toggle — flips enabled/disabled. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await params;
  const result = getDb()
    .prepare("UPDATE scrape_sources SET enabled = 1 - enabled WHERE id = ?")
    .run(id);

  if (Number(result.changes) === 0) {
    return Response.json({ error: "not_found", message: "No such source." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
