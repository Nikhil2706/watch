import { requestJobControl } from "@/lib/jobs";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/jobs/:id/control  { action: "pause" | "resume" }
 *
 * Open to any signed-in viewer rather than admin-only. Pausing affects everyone,
 * but this is an invite-only instance shared between people who know each other,
 * and the realistic reason to hit pause is "the encode is making my film
 * stutter" — which is exactly the person watching, not the admin. The action is
 * also cheap to undo.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: NO_STORE },
    );
  }

  const { id } = await context.params;

  let action: string;
  try {
    const body = await readJsonBody(request);
    action = String(body.action ?? "");
  } catch {
    return Response.json(
      { error: "invalid_request", message: "Malformed body." },
      { status: 400, headers: NO_STORE },
    );
  }

  if (action !== "pause" && action !== "resume") {
    return Response.json(
      { error: "invalid_request", message: "action must be pause or resume." },
      { status: 400, headers: NO_STORE },
    );
  }

  const accepted = requestJobControl(id, action);
  if (!accepted) {
    // Either the job is gone, or it is not in a state this action applies to —
    // pausing something already finished, say.
    return Response.json(
      { error: "not_applicable", message: `Cannot ${action} this job right now.` },
      { status: 409, headers: NO_STORE },
    );
  }

  console.log(`[jobs] ${session.username} requested ${action} on job ${id}`);
  return Response.json({ ok: true, action }, { headers: NO_STORE });
}
