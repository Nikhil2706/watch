import { requireAdmin } from "@/lib/admin-auth";
import { listUploads } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/uploads
 *
 * listUploads() opportunistically reconciles any new Windows-Defender
 * marker files before returning — see reconcileScanResults() in
 * src/lib/uploads.ts. That keeps this route as the one place scan results
 * actually get picked up, with no separate polling process on the gate
 * side.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const uploads = listUploads();
  return Response.json({ uploads }, { headers: NO_STORE });
}
