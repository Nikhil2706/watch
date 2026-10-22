import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { listingFacts, readListingSources } from "@/lib/catalogue-facts";
import { LEGACY_OPTIONS, legacyListed } from "@/lib/catalogue-legacy";
import { deriveCatalogueState, isListed, LIST_CONTEXTS, type ListContext } from "@/lib/catalogue-state";
import { getEpisodeVisibilityIndex, isUngroupedEpisode } from "@/lib/episode-visibility";
import { getDamagedPathSet } from "@/lib/file-checks";
import { getAlternateVersionPathSet } from "@/lib/film-versions";
import { hasNoMetadata } from "@/lib/has-metadata";
import { getExcludedPathSet, getWhitelistedPathSet } from "@/lib/library-curation";
import { getHiddenRolloutImdbSet, getHiddenRolloutPathSet } from "@/lib/rollout";
import { getSpecialFeatureIdSet } from "@/lib/special-features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/admin/catalogue/snapshot
 *
 * Proof, against the live library, that the catalogue state lists exactly
 * what the old filterVisible did (docs/catalogue-state.md, 6.2). For every
 * file and every list context it works out the old answer from the original
 * per-source reads, independently of catalogue-facts.ts, and the new one
 * through it, and returns every file where they differ. Expected: none.
 * Parental control is left out of both: it is the same code either way.
 *
 * Run it with scripts/catalogue-snapshot.mjs. Read-only.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  try {
    const items = await getAdminMovies({ withMediaSources: false });

    const excluded = getExcludedPathSet();
    const damaged = getDamagedPathSet();
    const whitelisted = getWhitelistedPathSet();
    const episodes = getEpisodeVisibilityIndex();
    const rolloutPaths = getHiddenRolloutPathSet();
    const rolloutImdb = getHiddenRolloutImdbSet();
    const features = getSpecialFeatureIdSet();
    const alternates = getAlternateVersionPathSet();
    const sources = readListingSources();

    const differences: Array<{ path: string | null; name: string; context: ListContext; before: boolean; now: boolean }> = [];
    const listed: Record<ListContext, { before: number; now: number }> = {
      discovery: { before: 0, now: 0 },
      resume: { before: 0, now: 0 },
      show_episodes: { before: 0, now: 0 },
    };

    for (const item of items) {
      const path = item.Path;
      const imdb = item.ProviderIds?.Imdb;
      const legacy = {
        specialFeature: features.has(item.Id),
        alternateVersion: !!path && alternates.has(path),
        excluded: !!path && excluded.has(path),
        damaged: !!path && damaged.has(path),
        ungroupedEpisode: isUngroupedEpisode(item, episodes),
        noMetadata: hasNoMetadata(item),
        whitelisted: !!path && whitelisted.has(path),
        scheduled: (!!path && rolloutPaths.has(path)) || (!!imdb && rolloutImdb.has(imdb)),
      };
      const state = deriveCatalogueState(listingFacts(item, sources));
      for (const context of LIST_CONTEXTS) {
        const before = legacyListed(legacy, LEGACY_OPTIONS[context]);
        const now = isListed(state, context);
        if (before) listed[context].before++;
        if (now) listed[context].now++;
        if (before !== now) differences.push({ path: path ?? null, name: item.Name, context, before, now });
      }
    }

    return Response.json({ files: items.length, listed, differences }, { headers: NO_STORE });
  } catch (error) {
    console.error("[admin/catalogue/snapshot] failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not compare the library." },
      { status: 500, headers: NO_STORE },
    );
  }
}
