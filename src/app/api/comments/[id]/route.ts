import { editComment, softDeleteComment } from "@/lib/community";
import { getSessionFromRequest } from "@/lib/session";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** PATCH /api/comments/{id}  { body } — own comment only. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }
  const { id } = await params;

  try {
    const raw = await readJsonBody(request);
    const body = optionalString(raw, "body");
    if (!body) throw new ValidationError("body is required.");

    const edited = editComment(id, session.userId, body);
    if (!edited) {
      return Response.json(
        { error: "not_found", message: "That's not your comment, or it no longer exists." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[comments] edit failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save that." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE /api/comments/{id} — soft delete, own comment only. Replies underneath stay visible. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }
  const { id } = await params;

  const removed = softDeleteComment(id, session.userId);
  if (!removed) {
    return Response.json(
      { error: "not_found", message: "That's not your comment, or it's already gone." },
      { status: 404, headers: NO_STORE },
    );
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
