/**
 * One decision API for the catalogue (docs/catalogue-state.md, 3.4): what a
 * curator's "show anyway", "hide", "this is an episode"... means, as the
 * writes the existing functions already make. Planning only — pure and
 * import-free, so the mapping and its round trips are tested directly;
 * catalogue-decisions.ts carries the writes out and logs them.
 *
 * A decision never writes anything new: each write here is one call to the
 * function the old endpoint called (library-curation, file-checks,
 * series-autogroup, special-features, film-versions, folder-match).
 */

import type { CatalogueFacts } from "./catalogue-state";

export type FeatureTargetKind = "film" | "franchise" | "director" | "actor";

/** One write, named for the existing function that makes it. */
export type CatalogueWrite =
  | { op: "excludePath"; path: string; note: string | null }
  | { op: "unexcludePath"; path: string }
  | { op: "whitelistPath"; path: string }
  | { op: "unwhitelistPath"; path: string }
  | { op: "setDamagedAllowed"; path: string; allowed: boolean }
  | { op: "requestRecheck"; path: string }
  | { op: "keepAsFilm"; path: string }
  | { op: "removeFromGroup"; path: string }
  | { op: "addToGroup"; groupId: string; path: string }
  | { op: "groupSeriesNow"; seriesKey: string }
  | { op: "markSpecialFeature"; itemId: string }
  | { op: "unmarkSpecialFeature"; itemId: string }
  | { op: "addTarget"; itemId: string; kind: FeatureTargetKind; targetId: string }
  | { op: "removeFromVersionSet"; path: string }
  | { op: "createVersionSet"; primaryPath: string; path: string }
  | { op: "setVersionLabel"; path: string; label: string }
  | { op: "acceptFolderSuggestion"; path: string };

/** The reasons "show anyway" and "take off" answer. */
export type OverridableReason = "damaged" | "no_metadata";

export type Placement =
  | { as: "film" }
  | { as: "episode"; groupId?: string; seriesKey?: string }
  | { as: "special_feature"; target?: { kind: FeatureTargetKind; id: string } }
  | { as: "version"; of: string; label?: string };

export type DecisionRequest =
  | { action: "show_anyway"; reason?: OverridableReason }
  | { action: "take_off"; reason: OverridableReason }
  | { action: "hide"; note?: string }
  | { action: "unhide" }
  | { action: "replace_recheck" }
  | { action: "place_as"; placement: Placement }
  | { action: "accept_suggestion" };

export type DecisionPlan = { ok: true; writes: CatalogueWrite[] } | { ok: false; message: string };

const FEATURE_KINDS: readonly FeatureTargetKind[] = ["film", "franchise", "director", "actor"];

function fail(message: string): DecisionPlan {
  return { ok: false, message };
}

/**
 * Taking a file out of whatever it is placed as. All three are no-ops when it
 * isn't, so they are planned without asking: the listing read leaves `group`
 * out, and a wrong guess here would leave a file in two places at once.
 */
function unplace(path: string, itemId: string, keep: "group" | "feature" | "version" | null): CatalogueWrite[] {
  const out: CatalogueWrite[] = [];
  if (keep !== "group") out.push({ op: "removeFromGroup", path });
  if (keep !== "feature") out.push({ op: "unmarkSpecialFeature", itemId });
  if (keep !== "version") out.push({ op: "removeFromVersionSet", path });
  return out;
}

export function planDecision(facts: CatalogueFacts, request: DecisionRequest): DecisionPlan {
  const path = facts.path;
  if (!path) return fail("This item has no file path, so nothing can be decided about it.");

  switch (request.action) {
    case "show_anyway": {
      const writes: CatalogueWrite[] = [];
      const wantDamaged = request.reason === undefined || request.reason === "damaged";
      const wantMetadata = request.reason === undefined || request.reason === "no_metadata";
      if (wantDamaged && facts.damaged && !facts.damaged.allowed) writes.push({ op: "setDamagedAllowed", path, allowed: true });
      if (wantMetadata && !facts.hasMetadata && !facts.whitelisted) writes.push({ op: "whitelistPath", path });
      if (writes.length) return { ok: true, writes };
      if (request.reason === "damaged" && !facts.damaged) return fail("That file has no damage on record.");
      if (request.reason === "no_metadata" && facts.hasMetadata) return fail("That file has its metadata.");
      // Already shown anyway: idempotent.
      return { ok: true, writes: [] };
    }

    case "take_off":
      if (request.reason === "damaged") {
        if (!facts.damaged) return fail("That file has no damage on record.");
        return { ok: true, writes: facts.damaged.allowed ? [{ op: "setDamagedAllowed", path, allowed: false }] : [] };
      }
      return { ok: true, writes: facts.whitelisted ? [{ op: "unwhitelistPath", path }] : [] };

    case "hide":
      return { ok: true, writes: [{ op: "excludePath", path, note: request.note?.trim() || null }] };

    case "unhide":
      return { ok: true, writes: facts.excluded ? [{ op: "unexcludePath", path }] : [] };

    case "replace_recheck":
      if (!facts.damaged) return fail("That file has no check to repeat.");
      return { ok: true, writes: [{ op: "requestRecheck", path }] };

    case "accept_suggestion":
      return { ok: true, writes: [{ op: "acceptFolderSuggestion", path }] };

    case "place_as": {
      const p = request.placement;
      switch (p.as) {
        case "film":
          return { ok: true, writes: [...unplace(path, facts.itemId, null), { op: "keepAsFilm", path }] };

        case "episode": {
          if (p.groupId) {
            return {
              ok: true,
              writes: [...unplace(path, facts.itemId, "group"), { op: "addToGroup", groupId: p.groupId, path }],
            };
          }
          if (p.seriesKey) {
            return {
              ok: true,
              writes: [...unplace(path, facts.itemId, "group"), { op: "groupSeriesNow", seriesKey: p.seriesKey }],
            };
          }
          return fail("Say which show: a groupId, or the seriesKey of a detected series.");
        }

        case "special_feature": {
          const writes: CatalogueWrite[] = [
            ...unplace(path, facts.itemId, "feature"),
            { op: "markSpecialFeature", itemId: facts.itemId },
          ];
          if (p.target) {
            if (!FEATURE_KINDS.includes(p.target.kind) || !p.target.id) return fail("A feature's target needs a kind and an id.");
            writes.push({ op: "addTarget", itemId: facts.itemId, kind: p.target.kind, targetId: p.target.id });
          }
          return { ok: true, writes };
        }

        case "version": {
          if (!p.of || p.of === path) return fail("Say which film this is another cut of (its path), not itself.");
          const writes: CatalogueWrite[] = [
            ...unplace(path, facts.itemId, "version"),
            { op: "createVersionSet", primaryPath: p.of, path },
          ];
          if (p.label?.trim()) writes.push({ op: "setVersionLabel", path, label: p.label.trim() });
          return { ok: true, writes };
        }
      }
    }
  }
}

/**
 * Reads a decision from a request body. Returns a message for anything it
 * can't read rather than guessing: a decision moves a film on or off the site.
 */
export function parseDecision(body: Record<string, unknown>): DecisionRequest | string {
  const str = (key: string): string | undefined => {
    const v = body[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const reason = str("reason");
  if (reason !== undefined && reason !== "damaged" && reason !== "no_metadata") return "reason must be damaged or no_metadata.";
  const r = reason as OverridableReason | undefined;

  switch (body.action) {
    case "show_anyway":
      return { action: "show_anyway", reason: r };
    case "take_off":
      return r ? { action: "take_off", reason: r } : "take_off needs a reason: damaged or no_metadata.";
    case "hide":
      return { action: "hide", note: str("note") };
    case "unhide":
    case "replace_recheck":
    case "accept_suggestion":
      return { action: body.action };
    case "place_as": {
      switch (body.as) {
        case "film":
          return { action: "place_as", placement: { as: "film" } };
        case "episode":
          return { action: "place_as", placement: { as: "episode", groupId: str("groupId"), seriesKey: str("seriesKey") } };
        case "special_feature": {
          const t = body.target as { kind?: unknown; id?: unknown } | undefined;
          if (t === undefined) return { action: "place_as", placement: { as: "special_feature" } };
          if (typeof t !== "object" || t === null || typeof t.kind !== "string" || typeof t.id !== "string") {
            return "target must be { kind, id }.";
          }
          return {
            action: "place_as",
            placement: { as: "special_feature", target: { kind: t.kind as FeatureTargetKind, id: t.id } },
          };
        }
        case "version": {
          const of = str("of");
          return of ? { action: "place_as", placement: { as: "version", of, label: str("label") } } : "place_as version needs of: the other film's path.";
        }
        default:
          return "as must be film, episode, special_feature or version.";
      }
    }
    case "identify":
      return "Identify a film from the Library tab (TMDB search); its state follows its metadata.";
    case "release_now":
      return "release_now isn't available yet: a rollout is released from its show's schedule.";
    default:
      return "Unknown action.";
  }
}
