import { requireAdmin } from "@/lib/admin-auth";
import { deleteCuratorAccolade, renameCuratorAccolade } from "@/lib/scraping/curator-accolades";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** PATCH /api/admin/accolades/builder/{id} — { name } */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;

  try {
    const body = await readJsonBody(request);
    const name = optionalString(body, "name");
    if (!name || !name.trim()) throw new ValidationError("name is required.");
    renameCuratorAccolade(id, name.trim());
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[accolades/builder] rename failed:", error);
    return Response.json({ error: "internal_error", message: "Could not rename the accolade." }, { status: 500, headers: NO_STORE });
  }
}

/** DELETE /api/admin/accolades/builder/{id} */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const removed = deleteCuratorAccolade(id);
  if (!removed) {
    return Response.json({ error: "not_found", message: "No such accolade." }, { status: 404, headers: NO_STORE });
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}
