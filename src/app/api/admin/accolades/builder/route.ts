import { requireAdmin } from "@/lib/admin-auth";
import { createCuratorAccolade, listCuratorAccoladeEntries, listCuratorAccolades } from "@/lib/scraping/curator-accolades";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/accolades/builder — every curator-built accolade, each with its slots. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const accolades = listCuratorAccolades().map((a) => ({
    ...a,
    entries: listCuratorAccoladeEntries(a.id),
  }));
  return Response.json({ accolades }, { headers: NO_STORE });
}

/** POST /api/admin/accolades/builder — { name } */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const body = await readJsonBody(request);
    const name = optionalString(body, "name");
    if (!name || !name.trim()) throw new ValidationError("name is required.");
    const accolade = createCuratorAccolade(name.trim());
    return Response.json({ ok: true, accolade }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/builder] create failed:", error);
    return Response.json({ error: "internal_error", message: "Could not create the accolade." }, { status: 500, headers: NO_STORE });
  }
}
