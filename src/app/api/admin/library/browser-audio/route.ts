import { requireAdmin } from "@/lib/admin-auth";
import { browserAudioStatus, requestBrowserAudio } from "@/lib/browser-audio";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET  /api/admin/library/browser-audio?path=...  what the worker did to that file
 * POST /api/admin/library/browser-audio { path }   "Add browser audio now": the
 *   worker looks at it next (when nothing is queued and nobody is watching),
 *   adds the stereo AAC track if the film needs one, and records why not if not.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const path = new URL(request.url).searchParams.get("path");
  if (!path) return Response.json({ error: "invalid_request", message: "path is required." }, { status: 400, headers: NO_STORE });
  return Response.json({ path, result: browserAudioStatus(path) }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path || !path.startsWith("/media/")) throw new ValidationError("path must be a library file (/media/...).");
    requestBrowserAudio(path);
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/browser-audio] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not do that." }, { status: 500, headers: NO_STORE });
  }
}
