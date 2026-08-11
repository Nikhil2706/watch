import { requireAdmin } from "@/lib/admin-auth";
import { deleteCuration } from "@/lib/curations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** DELETE /api/admin/curations/:id */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { id } = await context.params;
  const removed = deleteCuration(id);

  if (!removed) {
    return Response.json(
      { error: "not_found", message: `No pick with id ${id}.` },
      { status: 404, headers: NO_STORE },
    );
  }
  return Response.json({ id, deleted: true }, { headers: NO_STORE });
}
