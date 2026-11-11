import { requireAdmin } from "@/lib/admin-auth";
import { setGroupAudioLanguage } from "@/lib/library-curation";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/group-audio { groupId, language }
 * The audio language a show plays in when its files default to another
 * ("eng"); an empty language goes back to each file's own default.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const groupId = optionalString(body, "groupId");
    const language = (optionalString(body, "language") ?? "").trim().toLowerCase();
    if (!groupId) throw new ValidationError("groupId is required.");
    if (language && !/^[a-z]{3}$/.test(language)) throw new ValidationError("language is a three-letter code, like eng.");
    setGroupAudioLanguage(groupId, language || null);
    return Response.json({ ok: true, language: language || null }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/group-audio] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the language." }, { status: 500, headers: NO_STORE });
  }
}
