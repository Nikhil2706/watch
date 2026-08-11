import { requireAdmin } from "@/lib/admin-auth";
import { listJobs } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/jobs
 *
 * Ingest queue, including failures — which viewers never see. A conversion that
 * failed is an operator problem, not something to show someone browsing.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const jobs = listJobs().map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      progress: job.progress,
      speed: job.speed,
      source_path: job.source_path,
      output_path: job.output_path,
      error: job.error,
      size_in_gb: job.bytes_in ? +(job.bytes_in / 1e9).toFixed(2) : null,
      size_out_gb: job.bytes_out ? +(job.bytes_out / 1e9).toFixed(2) : null,
      created_at: new Date(job.created_at).toISOString(),
      finished_at: job.finished_at ? new Date(job.finished_at).toISOString() : null,
      duration_seconds:
        job.started_at && job.finished_at
          ? Math.round((job.finished_at - job.started_at) / 1000)
          : null,
    }));

    const counts: Record<string, number> = {};
    for (const job of jobs) counts[job.status] = (counts[job.status] ?? 0) + 1;

    return Response.json({ jobs, count: jobs.length, by_status: counts }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/jobs] list failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not list jobs." },
      { status: 500, headers: NO_STORE },
    );
  }
}
