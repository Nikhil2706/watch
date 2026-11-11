import { requireAdmin } from "@/lib/admin-auth";
import { invalidate } from "@/lib/cache";
import { setTrackLanguages } from "@/lib/subtitles";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX = 5000;

/**
 * POST /api/admin/library/subtitle-language { set: [{ path, index, language }] }
 * The language of built-in subtitle tracks that carry no tag, as read from
 * their text ("eng"). Used only where the track has no language of its own.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const set = body.set;
    if (!Array.isArray(set) || set.length === 0 || set.length > MAX) {
      throw new ValidationError(`set must be a list of 1-${MAX} entries.`);
    }
    const entries = set.map((e) => {
      const x = e as { path?: unknown; index?: unknown; language?: unknown };
      const ok =
        typeof x.path === "string" &&
        x.path.startsWith("/") &&
        x.path.length <= 4096 &&
        Number.isInteger(x.index) &&
        (x.index as number) >= 0 &&
        typeof x.language === "string" &&
        /^[a-z]{3}$/.test(x.language);
      if (!ok) throw new ValidationError("Each entry needs a path, a stream index and a three-letter language.");
      return { path: x.path as string, index: x.index as number, language: x.language as string };
    });
    const saved = setTrackLanguages(entries);
    invalidate("all-movies");
    return Response.json({ saved }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/subtitle-language] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the languages." }, { status: 500, headers: NO_STORE });
  }
}
