import { requireAdmin } from "@/lib/admin-auth";
import { listAccoladeFilms } from "@/lib/accolades-films";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/accolades/films
 *
 * Every film with the state of its editorial curation — what material is
 * attached, and what has been chosen from it. This is what lets the Accolades
 * tab open on a list of films worth looking at rather than on a search box,
 * which is why nothing in it had ever been curated.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const films = await listAccoladeFilms();
    return Response.json({ films }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/accolades/films] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not load the films." },
      { status: 500, headers: NO_STORE },
    );
  }
}
