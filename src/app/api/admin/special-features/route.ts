import { requireAdmin } from "@/lib/admin-auth";
import { invalidateAdminMovies } from "@/lib/admin-library-cache";
import {
  addTarget,
  isTargetKind,
  listSpecialFeatures,
  markSpecialFeature,
  removeTarget,
  unmarkSpecialFeature,
} from "@/lib/special-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET  /api/admin/special-features   — everything marked, with its mappings
 * POST /api/admin/special-features   — mark, unmark, map, unmap
 *
 * One route with an `action` rather than four, because the console does all of
 * this from a single panel and every action invalidates the same cache. The
 * shapes are small enough that splitting them would be more files than
 * meaning.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json({ features: listSpecialFeatures() }, { headers: NO_STORE });
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: {
    action?: string;
    itemId?: string;
    title?: string | null;
    note?: string | null;
    kind?: string;
    targetId?: string;
    targetLabel?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400, headers: NO_STORE });
  }

  const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
  if (!itemId) {
    return Response.json(
      { error: "missing_item", message: "itemId is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  switch (body.action) {
    case "mark":
      markSpecialFeature(itemId, body.title ?? null, body.note ?? null);
      break;

    case "unmark":
      unmarkSpecialFeature(itemId);
      break;

    case "map":
    case "unmap": {
      const kind = typeof body.kind === "string" ? body.kind : "";
      const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
      if (!isTargetKind(kind) || !targetId) {
        return Response.json(
          { error: "bad_target", message: "kind must be film/franchise/director/actor, with a targetId." },
          { status: 400, headers: NO_STORE },
        );
      }
      if (body.action === "map") {
        // Mapping implies marking. Otherwise it is possible to map something
        // that is still sitting in Browse, which is never what was meant.
        markSpecialFeature(itemId, body.title ?? null, null);
        addTarget(itemId, kind, targetId, body.targetLabel ?? null);
      } else {
        removeTarget(itemId, kind, targetId);
      }
      break;
    }

    default:
      return Response.json(
        { error: "bad_action", message: "action must be mark, unmark, map or unmap." },
        { status: 400, headers: NO_STORE },
      );
  }

  // Marking changes what Browse contains, and the admin library listing is
  // cached — without this the console shows the old answer until it expires.
  invalidateAdminMovies();

  return Response.json({ ok: true, features: listSpecialFeatures() }, { headers: NO_STORE });
}
