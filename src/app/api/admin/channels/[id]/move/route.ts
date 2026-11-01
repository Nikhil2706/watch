import { requireAdmin } from "@/lib/admin-auth";
import { moveChannel } from "@/lib/channels";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { direction: -1 | 1 } — one place along the guide. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const body = (await readJsonBody(request).catch(() => ({}))) as { direction?: number };
  moveChannel(id, body.direction === -1 ? -1 : 1);
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
