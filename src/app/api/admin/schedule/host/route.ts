import { requireAdmin } from "@/lib/admin-auth";
import { collectHostJobs, finishRun } from "@/lib/scheduler";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * For scripts/host-jobs.sh, which cron runs once a minute on the computer
 * the site lives on. The site cannot start a script outside its container,
 * so the host asks instead.
 *
 * GET  — the host jobs due now, one per line as "runId kind forced", so a
 *        shell script can read it without a JSON parser. Each one handed out
 *        is marked started; asking again does not hand it out again.
 * POST — { run_id, ok: "1" | "0", summary? } how one of them ended.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const lines = collectHostJobs().map((j) => `${j.runId} ${j.kind} ${j.forced ? 1 : 0}`);
  return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const runId = optionalString(body, "run_id");
    if (!runId) throw new ValidationError("run_id is required.");
    const summary = typeof body.summary === "string" ? body.summary.slice(0, 1000) : null;
    if (optionalString(body, "ok") === "1") finishRun(runId, { summary });
    else finishRun(runId, { error: summary || "The script reported a failure." });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/schedule/host] report failed:", error);
    return Response.json({ error: "internal_error", message: "Could not record the result." }, { status: 500, headers: NO_STORE });
  }
}
