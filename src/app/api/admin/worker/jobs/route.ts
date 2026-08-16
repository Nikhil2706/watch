import { requireAdmin } from "@/lib/admin-auth";
import { listJobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/worker/jobs — the media_jobs queue, most recent first, for the dashboard's "queued for conversion" list. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    return Response.json({ jobs: listJobs(50) }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/worker/jobs] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load the job queue." },
      { status: 500, headers: NO_STORE },
    );
  }
}
