import { requireAdmin } from "@/lib/admin-auth";
import { getHealthSnapshot } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/health
 *
 * A snapshot of everything worth knowing about the platform's current state,
 * for the Curator's Dashboard's Health tab. Every check runs fresh on each
 * request — nothing here is expensive enough to need caching.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const snapshot = await getHealthSnapshot();
    return Response.json(snapshot, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/health] snapshot failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not gather health data." },
      { status: 500, headers: NO_STORE },
    );
  }
}
