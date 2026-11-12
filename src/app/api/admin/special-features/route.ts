import { requireAdmin } from "@/lib/admin-auth";
import { invalidateAdminMovies } from "@/lib/admin-library-cache";
import { logDecision } from "@/lib/catalogue-decisions";
import { setManualMetadata } from "@/lib/jellyfin";
import {
  addTarget,
  isSpecialFeature,
  isTargetKind,
  listSpecialFeatures,
  markSpecialFeature,
  removeTarget,
  renameSpecialFeature,
  unmarkSpecialFeature,
} from "@/lib/special-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET  /api/admin/special-features   — everything marked, with its mappings
 * POST /api/admin/special-features   — mark, unmark, map, unmap, rename
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
    /** rename, or map with a new name: written to Jellyfin as the item's own name. */
    name?: string | null;
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
    // Features are keyed on Jellyfin item id, not path (docs/catalogue-state.md,
    // open question 3), so they are logged under the item.
    case "mark":
      markSpecialFeature(itemId, body.title ?? null, body.note ?? null);
      logDecision({ path: `item:${itemId}`, action: "place_as", params: { as: "special_feature" } });
      break;

    case "unmark":
      unmarkSpecialFeature(itemId);
      logDecision({ path: `item:${itemId}`, action: "unmark_special_feature" });
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
        logDecision({ path: `item:${itemId}`, action: "place_as", params: { as: "special_feature", target: { kind, id: targetId } } });
      } else {
        removeTarget(itemId, kind, targetId);
      }
      break;
    }

    case "rename":
      if (!(typeof body.name === "string" && body.name.trim())) {
        return Response.json({ error: "missing_name", message: "name is required." }, { status: 400, headers: NO_STORE });
      }
      // Only an extra is renamed here: a film's name comes from identifying it.
      if (!isSpecialFeature(itemId)) {
        return Response.json({ error: "not_a_feature", message: "Only a special feature is renamed here." }, { status: 400, headers: NO_STORE });
      }
      break;

    default:
      return Response.json(
        { error: "bad_action", message: "action must be mark, unmark, map, unmap or rename." },
        { status: 400, headers: NO_STORE },
      );
  }

  // A name for an extra that has none worth showing ("Angel.1xEX.I'm_Cordelia"):
  // written to Jellyfin, locked, so the show's row and the extra's own page
  // both read it, and kept as the console's title.
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (name && (body.action === "rename" || body.action === "map")) {
    renameSpecialFeature(itemId, name);
    try {
      await setManualMetadata(itemId, { name });
    } catch (error) {
      return Response.json(
        { error: "jellyfin", message: `Saved here, but Jellyfin did not take the name: ${error instanceof Error ? error.message : String(error)}`, features: listSpecialFeatures() },
        { status: 502, headers: NO_STORE },
      );
    }
    logDecision({ path: `item:${itemId}`, action: "rename_special_feature", params: { name } });
  }

  // Marking changes what Browse contains, and the admin library listing is
  // cached — without this the console shows the old answer until it expires.
  invalidateAdminMovies();

  return Response.json({ ok: true, features: listSpecialFeatures() }, { headers: NO_STORE });
}
