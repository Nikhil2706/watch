import { requireAdmin } from "@/lib/admin-auth";
import { getGroup } from "@/lib/library-curation";
import { getSeriesById } from "@/lib/scraping/film-series";
import { getRolloutPlan, listRolloutSlots, setRolloutPlan, type RolloutMode, type RolloutSubjectType } from "@/lib/rollout";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const VALID_MODES: RolloutMode[] = ["immediate", "daily", "weekly"];
const VALID_SUBJECTS: RolloutSubjectType[] = ["group", "series"];

function subjectExists(subjectType: RolloutSubjectType, subjectId: string): boolean {
  return subjectType === "group" ? getGroup(subjectId) !== null : getSeriesById(subjectId) !== null;
}

/** GET /api/admin/library/rollout?subjectType=group|series&subjectId= — the plan (if any) plus every slot, for the curator's rollout panel (TV group-manage or the film-series detail view). */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const subjectType = url.searchParams.get("subjectType") as RolloutSubjectType | null;
  const subjectId = url.searchParams.get("subjectId");
  if (!subjectType || !VALID_SUBJECTS.includes(subjectType) || !subjectId) {
    return Response.json({ error: "invalid_request", message: "subjectType and subjectId are required." }, { status: 400, headers: NO_STORE });
  }

  const plan = getRolloutPlan(subjectType, subjectId);
  return Response.json(
    { plan, slots: plan ? listRolloutSlots(plan.id) : [] },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/admin/library/rollout
 * Body: { subjectType, subjectId, mode, perRelease, weekday?, timeOfDay?, startAt, expectedTotal }
 *
 * Creates or updates the subject's rollout plan and (re)schedules every
 * not-yet-revealed slot — see setRolloutPlan()'s own comment in rollout.ts
 * for exactly what "update" does and doesn't touch. Slot-to-content
 * assignment (which episode/film fills which slot) is reconciled inside
 * setRolloutPlan for a TV group automatically; a film series' slots are
 * reconciled separately by the film-series detail route, which is the one
 * that already resolves ownership via listAllMoviesAdmin().
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const subjectType = optionalString(body, "subjectType") as RolloutSubjectType | undefined;
    const subjectId = optionalString(body, "subjectId");
    const mode = optionalString(body, "mode");
    const perRelease = optionalInt(body, "perRelease");
    const weekday = optionalInt(body, "weekday");
    const timeOfDay = optionalString(body, "timeOfDay");
    const startAt = optionalInt(body, "startAt");
    const expectedTotal = optionalInt(body, "expectedTotal");

    if (!subjectType || !VALID_SUBJECTS.includes(subjectType) || !subjectId) {
      throw new ValidationError("subjectType and subjectId are required.");
    }
    if (!mode || !VALID_MODES.includes(mode as RolloutMode)) {
      throw new ValidationError('mode must be "immediate", "daily", or "weekly".');
    }
    if (!subjectExists(subjectType, subjectId)) throw new ValidationError("No such group or film series.");
    if (!expectedTotal || expectedTotal < 1) throw new ValidationError("expectedTotal must be at least 1.");
    if (mode === "weekly" && (weekday === undefined || weekday < 0 || weekday > 6)) {
      throw new ValidationError("weekday (0-6) is required for weekly mode.");
    }

    const plan = setRolloutPlan(subjectType, subjectId, {
      mode: mode as RolloutMode,
      perRelease: perRelease && perRelease > 0 ? perRelease : 1,
      weekday: mode === "weekly" ? (weekday ?? null) : null,
      timeOfDay: mode === "weekly" ? (timeOfDay ?? "09:00") : null,
      startAt: startAt ?? Date.now(),
      expectedTotal,
    });

    return Response.json({ plan, slots: listRolloutSlots(plan.id) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/rollout] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the rollout plan." }, { status: 500, headers: NO_STORE });
  }
}
