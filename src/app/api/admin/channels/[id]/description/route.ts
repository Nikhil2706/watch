import { requireAdmin } from "@/lib/admin-auth";
import { DESCRIPTION_MAX, setChannelDescription } from "@/lib/channels";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * PUT /api/admin/channels/{id}/description { description } — what the
 * channel is, shown on the guide beside the programme's own summary. Kept
 * apart from saving the channel, which works its lineup out again.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const { id } = await params;
    const body = await readJsonBody(request);
    const description = body.description ?? "";
    if (typeof description !== "string") throw new ValidationError("description must be text.");
    if (description.length > DESCRIPTION_MAX * 2) throw new ValidationError(`Keep it under ${DESCRIPTION_MAX} characters.`);
    if (!setChannelDescription(id, description)) {
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/channels] description not saved:", error);
    return Response.json({ error: "internal_error", message: "Could not save the description." }, { status: 500, headers: NO_STORE });
  }
}
