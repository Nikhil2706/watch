import { requireAdmin } from "@/lib/admin-auth";
import { optionalString, readJsonBody } from "@/lib/validation";
import { rejectUpload, UploadReviewError } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** POST /api/admin/uploads/:id/reject  { reviewed_by? } — deletes the quarantined file. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;

  let reviewedBy = "curator";
  try {
    const body = await readJsonBody(request);
    reviewedBy = optionalString(body, "reviewed_by") ?? reviewedBy;
  } catch {
    /* no body is fine — reviewed_by stays at its default */
  }

  try {
    rejectUpload(id, reviewedBy);
    return Response.json({ ok: true, id, status: "rejected" }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof UploadReviewError ? error.message : "Could not reject this upload.";
    if (!(error instanceof UploadReviewError)) console.error(`[admin/uploads] reject failed for ${id}:`, error);
    return Response.json({ error: "reject_failed", message }, { status: 409, headers: NO_STORE });
  }
}
