import { requireAdmin } from "@/lib/admin-auth";
import { queueTransform } from "@/lib/jobs";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/worker/transform
 * Body: { path, title }
 *
 * Queues one file for conversion — a row in media_jobs, nothing more. The
 * worker container stays off until it's started explicitly; this only ever
 * prepares its queue.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    const title = optionalString(body, "title");
    if (!path || !title) throw new ValidationError("path and title are required.");

    const result = queueTransform(path, title);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: "invalid_request", message: error.message },
        { status: 400, headers: NO_STORE },
      );
    }
    console.error("[admin/worker/transform] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not queue that file." },
      { status: 500, headers: NO_STORE },
    );
  }
}
