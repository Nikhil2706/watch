import { requireAdmin } from "@/lib/admin-auth";
import { revokeScreening } from "@/lib/screening";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Revoke, which is immediate.
 *
 * The proxy checks per request, so this kills a stream in progress within one
 * HLS segment. That is the correct behaviour, not a bug.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  revokeScreening(id);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
