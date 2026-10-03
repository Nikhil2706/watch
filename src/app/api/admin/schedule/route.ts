import { requireAdmin } from "@/lib/admin-auth";
import { ALWAYS_ON, getJobKind, listJobKinds } from "@/lib/job-kinds";
import { describeSchedule } from "@/lib/job-schedule";
import { scheduleFromBody } from "@/lib/schedule-body";
import {
  createJob,
  ensureBuiltinJobs,
  JobError,
  listJobs,
  listRuns,
  scheduleOf,
  parseParams,
  type ScheduledJob,
} from "@/lib/scheduler";
import { optionalBoolean, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function present(job: ScheduledJob) {
  const runs = listRuns(job.id, 5);
  const kind = getJobKind(job.kind);
  return {
    id: job.id,
    kind: job.kind,
    kindLabel: kind?.label ?? job.kind,
    description: kind?.description ?? "",
    label: job.label,
    params: parseParams(job),
    schedule: scheduleOf(job),
    scheduleText: describeSchedule(scheduleOf(job)),
    enabled: job.enabled === 1,
    skipIfPlaying: job.skip_if_playing === 1,
    builtin: job.builtin === 1,
    runner: job.runner,
    nextRunAt: job.next_run_at,
    waitingSince: job.waiting_since,
    runRequested: job.run_requested === 1,
    running: runs[0]?.status === "running",
    runs,
  };
}

/**
 * GET /api/admin/schedule — every scheduled job with its last few runs, the
 * kinds a new one can be, and the things that run on their own.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  // Also done at boot; here so the list is right on a database that was
  // migrated while the site was already up.
  ensureBuiltinJobs();
  return Response.json(
    {
      now: Date.now(),
      jobs: listJobs().map(present),
      kinds: listJobKinds().map((k) => ({
        kind: k.kind,
        label: k.label,
        description: k.description,
        runner: k.runner,
        params: k.params ?? [],
        politeByDefault: k.politeByDefault,
      })),
      alwaysOn: ALWAYS_ON,
    },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/admin/schedule
 *   { kind, params?, label?, cadence, hour, minute, weekday?, month_day?, skip_if_playing? }
 *
 * Times are India Standard Time.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const kind = optionalString(body, "kind");
    if (!kind) throw new ValidationError("Choose what the job should do.");
    const job = createJob({
      kind,
      label: optionalString(body, "label") ?? null,
      params: body.params,
      schedule: scheduleFromBody(body),
      skipIfPlaying: optionalBoolean(body, "skip_if_playing"),
    });
    return Response.json({ ok: true, job: present(job) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError || error instanceof JobError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/schedule] create failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not create the job." },
      { status: 500, headers: NO_STORE },
    );
  }
}
