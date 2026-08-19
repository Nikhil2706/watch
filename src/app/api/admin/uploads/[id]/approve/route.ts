import { requireAdmin } from "@/lib/admin-auth";
import { optionalString, readJsonBody } from "@/lib/validation";
import { approveUpload, UploadReviewError } from "@/lib/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/uploads/:id/approve  { reviewed_by? }
 *
 * Refuses anything not marked 'clean' by the antivirus scan — see
 * approveUpload() in src/lib/uploads.ts, which enforces that itself rather
 * than trusting this route to check first. Moves the file into
 * MEDIA_INCOMING for the existing watch-folder worker to pick up; nothing
 * about publishing into the real library happens here.
 */
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
    approveUpload(id, reviewedBy);
    return Response.json({ ok: true, id, status: "approved" }, { headers: NO_STORE });
  } catch (error) {
    const message = error instanceof UploadReviewError ? error.message : "Could not approve this upload.";
    if (!(error instanceof UploadReviewError)) console.error(`[admin/uploads] approve failed for ${id}:`, error);
    return Response.json({ error: "approve_failed", message }, { status: 409, headers: NO_STORE });
  }
}
