import { requireAdmin } from "@/lib/admin-auth";
import { invalidateAdminMovies } from "@/lib/admin-library-cache";
import { keepAsFilm } from "@/lib/series-autogroup";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";
import { logDecision } from "@/lib/catalogue-decisions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/admin/library/keep-as-film — Body: { path }.
 *
 * For a file recognised as an episode that is not one, or that should stay a
 * film of its own: it is shown on the site again and never grouped unasked.
 * The same record a dissolved group leaves (library_group_declined).
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const path = optionalString(body, "path");
    if (!path) throw new ValidationError("path is required.");

    keepAsFilm(path);
    logDecision({ path, action: "place_as", params: { as: "film" } });
    invalidateAdminMovies();
    return Response.json({ kept: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/library/keep-as-film] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not keep that file as a film." },
      { status: 500, headers: NO_STORE },
    );
  }
}
