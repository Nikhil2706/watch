import { requireAdmin } from "@/lib/admin-auth";
import { getChannel, rebuildChannel } from "@/lib/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/channels/{id}/rebuild — work the lineup out again: a genre
 * rule picks up films added since, a shuffle gets a new order. The clock is
 * kept.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  if (!getChannel(id)) return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return Response.json({ ok: true, ...(await rebuildChannel(id)) }, { headers: { "Cache-Control": "no-store" } });
}
