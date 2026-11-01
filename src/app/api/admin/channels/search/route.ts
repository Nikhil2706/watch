import { requireAdmin } from "@/lib/admin-auth";
import { searchForChannel } from "@/lib/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/channels/search?q= — films, episodes and shows to add to a lineup, and every genre. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const q = new URL(request.url).searchParams.get("q") ?? "";
  return Response.json(await searchForChannel(q), { headers: { "Cache-Control": "no-store" } });
}
