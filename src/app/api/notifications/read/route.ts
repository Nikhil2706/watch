import { markNotificationsRead } from "@/lib/notifications";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/notifications/read  { id } or { all: true } */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  try {
    const raw = await readJsonBody(request);
    if (raw.all === true) {
      markNotificationsRead(session.userId, { all: true });
    } else if (typeof raw.id === "string" && raw.id) {
      markNotificationsRead(session.userId, { id: raw.id });
    } else {
      throw new ValidationError("Provide either id or all:true.");
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[notifications/read] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not update that." }, { status: 500, headers: NO_STORE });
  }
}
