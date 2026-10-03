import { requireAdmin } from "@/lib/admin-auth";
import { deleteJob, getJob, JobError, startJob, updateJob } from "@/lib/scheduler";
import { scheduleFromBody } from "@/lib/schedule-body";
import { optionalBoolean, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function notFound(): Response {
  return Response.json({ error: "not_found", message: "No such job." }, { status: 404, headers: NO_STORE });
}

/**
 * PATCH /api/admin/schedule/{id}
 *   { label?, enabled?, skip_if_playing?, cadence?, hour?, minute?, weekday?, month_day? }
 *
 * Sending `cadence` reschedules the job, and the next run is counted from
 * now. Leaving it out keeps the schedule as it is.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  if (!getJob(id)) return notFound();

  try {
    const body = await readJsonBody(request);
    updateJob(id, {
      label: optionalString(body, "label"),
      enabled: optionalBoolean(body, "enabled"),
      skipIfPlaying: optionalBoolean(body, "skip_if_playing"),
      schedule: body.cadence === undefined ? undefined : scheduleFromBody(body),
    });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof JobError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/schedule] update failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the job." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** DELETE /api/admin/schedule/{id} — jobs you created only; the built-in ones can be paused instead. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;

  const outcome = deleteJob(id);
  if (outcome === "missing") return notFound();
  if (outcome === "builtin") {
    return Response.json(
      { error: "invalid_request", message: "This job came with the site. Pause it instead of deleting it." },
      { status: 400, headers: NO_STORE },
    );
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}

/**
 * POST /api/admin/schedule/{id} — run it now, whatever its schedule says.
 *
 * A site job starts at once and carries on in the background. A job that
 * runs on the computer itself is picked up by the host's runner within a
 * minute.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;

  const result = await startJob(id, "manual");
  if (result.started) return Response.json({ ok: true, started: true }, { status: 202, headers: NO_STORE });
  if (result.reason === "missing") return notFound();
  if (result.reason === "host") {
    return Response.json(
      { ok: true, started: false, message: "Queued. It starts on this computer within a minute." },
      { status: 202, headers: NO_STORE },
    );
  }
  return Response.json(
    { error: "already_running", message: "This job is already running." },
    { status: 409, headers: NO_STORE },
  );
}
