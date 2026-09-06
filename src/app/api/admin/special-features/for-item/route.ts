import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovie } from "@/lib/jellyfin";
import { getGroupedPathMap } from "@/lib/library-curation";
import {
  getFeatureIdsForFilm,
  getTargetsForFeatures,
  listSpecialFeatures,
  type TargetKind,
} from "@/lib/special-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/special-features/for-item?itemId=...
 *
 * The reverse lookup: what shows on THIS film's page. Selecting a film in the
 * console should answer that without having to hold four mappings in your
 * head and work it out.
 *
 * Uses the same gathering the film page does — film, then franchise, then
 * director, then actor — so the console cannot quietly disagree with the site
 * about what a viewer will see.
 *
 * The distinction that matters here is direct versus inherited. A making-of
 * mapped to this film can be unlinked from this film. A documentary that
 * appears because it is mapped to Ridley Scott is on every Ridley Scott film,
 * and "unlink" there removes it from all of them — so the response says which
 * is which, and how wide the removal reaches, rather than offering one button
 * that means two different things.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const itemId = new URL(request.url).searchParams.get("itemId")?.trim();
  if (!itemId) {
    return Response.json(
      { error: "missing_item", message: "itemId is required." },
      { status: 400, headers: NO_STORE },
    );
  }

  const item = await getAdminMovie(itemId, { withMediaSources: false, withPeople: true });
  if (!item) {
    return Response.json({ features: [] }, { headers: NO_STORE });
  }

  const groupIds: string[] = [];
  if (item.Path) {
    const group = getGroupedPathMap().get(item.Path);
    if (group) groupIds.push(group.groupId);
  }
  const directorIds = (item.People ?? []).filter((p) => p.Type === "Director").map((p) => p.Id);
  const actorIds = (item.People ?? []).filter((p) => p.Type === "Actor").map((p) => p.Id);

  const ids = getFeatureIdsForFilm({ itemId, groupIds, directorIds, actorIds }).filter(
    (id) => id !== itemId,
  );
  if (ids.length === 0) return Response.json({ features: [] }, { headers: NO_STORE });

  const targetsByFeature = getTargetsForFeatures(ids);
  const titles = new Map(listSpecialFeatures().map((f) => [f.itemId, f.title]));

  // Which of this film's own identifiers each mapping matched — that is what
  // makes a link direct or inherited.
  const mine: Record<TargetKind, Set<string>> = {
    film: new Set([itemId]),
    franchise: new Set(groupIds),
    director: new Set(directorIds),
    actor: new Set(actorIds),
  };

  const features = ids.map((id) => {
    const matched = (targetsByFeature.get(id) ?? []).filter((t) => mine[t.kind].has(t.targetId));
    return {
      itemId: id,
      title: titles.get(id) ?? id,
      // Every reason it reaches this page, each independently removable.
      via: matched.map((t) => ({
        kind: t.kind,
        targetId: t.targetId,
        targetLabel: t.targetLabel,
        direct: t.kind === "film",
        // Spelled out because "unlink" on an inherited mapping is a much
        // bigger action than it looks.
        scope:
          t.kind === "film"
            ? "this film"
            : `every film with ${t.targetLabel ?? "this " + t.kind}`,
      })),
    };
  });

  return Response.json({ features }, { headers: NO_STORE });
}
