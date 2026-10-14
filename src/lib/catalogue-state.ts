/**
 * One catalogue state per library file: whether it is on the site, and why.
 *
 * See docs/catalogue-state.md. Every fact here is still written where it was
 * before (library_excluded, file_checks, library_whitelisted, special_features,
 * film_versions, library_rollout_slots, library_groups, the episode facts);
 * this only reads them, as one thing. The rules that used to be a stack of
 * `if`s in media.ts's filterVisible are the REASONS table below, as data: which
 * lists each reason hides a file in, whether it wants the curator, and its
 * words. Behaviour is unchanged; catalogue-state.test.ts holds a verbatim copy
 * of the old rule and checks every combination against this one.
 *
 * Pure and import-free, so it is tested directly.
 */

/** Where a list is shown, which decides what may be in it. */
export type ListContext =
  /** Browse, Home rows, Search, More like this... anything for finding something new. */
  | "discovery"
  /** Continue Watching: a half-watched making-of or second cut carries on like anything else. */
  | "resume"
  /** A show's own episode list: grouping it already answered "is this a real title?". */
  | "show_episodes";

export const LIST_CONTEXTS: readonly ListContext[] = ["discovery", "resume", "show_episodes"];

/**
 * Everything about one file the rules read. Built by catalogue-facts.ts from
 * the existing tables and the Jellyfin item. The `detail` fields are optional:
 * listing needs only whether each fact holds; the console's words want more.
 */
export interface CatalogueFacts {
  path: string | null;
  itemId: string;
  /** False when Jellyfin has no overview and no IMDb or TMDB id (has-metadata.ts). */
  hasMetadata: boolean;
  /** "Show anyway" for a file with no metadata (library_whitelisted). */
  whitelisted: boolean;
  /** Hidden by the curator (library_excluded). */
  excluded: { note?: string | null } | null;
  /** The worker found the file damaged (file_checks); `allowed` is "show anyway". */
  damaged: { allowed: boolean; detail?: string | null } | null;
  /** A recognised episode in no group, not kept as a film (episode-visibility.ts). */
  ungroupedEpisode: { seriesName?: string | null } | null;
  /** In a show (library_groups). */
  group: { groupId: string; groupName: string } | null;
  /** Marked a special feature (special_features); `of` is what it is mapped to, if anything. */
  specialFeature: { of?: string | null; mapped?: boolean } | null;
  /** A cut of a film other than the one listed (film_versions). */
  alternateVersion: { label?: string | null; of?: string | null } | null;
  /** Waiting for its release date (library_rollout_slots, by path or IMDb id). */
  scheduled: { releaseAt?: number | null } | null;
  /** Folder matching has a guess waiting for a yes or no (folder_match_suggestions). */
  folderSuggestion: { title: string; year?: number | null; why?: string | null } | null;
  /** Another copy of the same film is in the library (duplicate-titles.ts). Console only. */
  duplicate: { copies?: number } | null;
}

export type ReasonCode =
  | "excluded"
  | "damaged"
  | "ungrouped_episode"
  | "identifying"
  | "no_metadata"
  | "scheduled"
  | "special_feature"
  | "version"
  | "episode"
  | "duplicate"
  | "damaged_allowed";

export type CatalogueStateName = "visible" | "placed" | "held" | "needs_decision" | "identifying";

export type DecisionAction =
  | "show_anyway"
  | "take_off"
  | "hide"
  | "unhide"
  | "replace_recheck"
  | "place_as"
  | "accept_suggestion"
  | "identify"
  | "release_now";

export interface Reason {
  code: ReasonCode;
  /** What the curator reads: "Damaged: 74 broken pieces of picture". */
  words: string;
  needsYou: boolean;
  hidesIn: readonly ListContext[];
  actions: readonly DecisionAction[];
}

export type Placement =
  | { as: "film" }
  | { as: "episode"; groupId: string; groupName: string }
  | { as: "special_feature"; of: string | null }
  | { as: "version"; of: string | null; label: string | null };

export interface CatalogueState {
  state: CatalogueStateName;
  /** Every reason that holds, most important first. Empty for a plain listed film. */
  reasons: Reason[];
  placement: Placement;
  /** Whether the curator's inbox lists it. */
  needsYou: boolean;
}

const ALL: readonly ListContext[] = LIST_CONTEXTS;
const DISCOVERY_AND_RESUME: readonly ListContext[] = ["discovery", "resume"];
/** Everywhere but Continue Watching: a half-watched making-of or second cut carries on there. */
const ALL_BUT_RESUME: readonly ListContext[] = ["discovery", "show_episodes"];
const NOWHERE: readonly ListContext[] = [];

/**
 * The rules. `holds` decides whether a reason applies; the order is the order
 * the console lists them in. "Hides in" is today's behaviour exactly — the
 * two exceptions (features and other cuts stay in Continue Watching; a show's
 * own list ignores missing metadata) included.
 */
interface Rule {
  code: ReasonCode;
  holds: (f: CatalogueFacts) => boolean;
  needsYou: (f: CatalogueFacts) => boolean;
  hidesIn: readonly ListContext[];
  actions: readonly DecisionAction[];
  words: (f: CatalogueFacts) => string;
}

const noMetadataUnanswered = (f: CatalogueFacts) => !f.hasMetadata && !f.whitelisted;

const RULES: readonly Rule[] = [
  {
    code: "excluded",
    holds: (f) => !!f.excluded,
    needsYou: () => false,
    hidesIn: ALL,
    actions: ["unhide"],
    words: (f) => (f.excluded?.note ? `Hidden by you: ${f.excluded.note}` : "Hidden by you"),
  },
  {
    code: "damaged",
    holds: (f) => !!f.damaged && !f.damaged.allowed,
    needsYou: () => true,
    hidesIn: ALL,
    actions: ["show_anyway", "replace_recheck", "hide"],
    words: (f) => (f.damaged?.detail ? `Damaged: ${f.damaged.detail}` : "Damaged"),
  },
  {
    code: "ungrouped_episode",
    holds: (f) => !!f.ungroupedEpisode,
    needsYou: () => true,
    hidesIn: ALL,
    actions: ["place_as", "hide"],
    words: (f) =>
      f.ungroupedEpisode?.seriesName
        ? `Episode of ${f.ungroupedEpisode.seriesName}, in no show`
        : "An episode, in no show",
  },
  {
    code: "identifying",
    holds: (f) => noMetadataUnanswered(f) && !!f.folderSuggestion,
    needsYou: () => true,
    hidesIn: DISCOVERY_AND_RESUME,
    actions: ["accept_suggestion", "identify", "show_anyway", "hide"],
    words: (f) => {
      const s = f.folderSuggestion!;
      return `Probably ${s.title}${s.year ? ` (${s.year})` : ""}${s.why ? `: ${s.why}` : ""}`;
    },
  },
  {
    code: "no_metadata",
    holds: (f) => noMetadataUnanswered(f) && !f.folderSuggestion,
    needsYou: () => true,
    hidesIn: DISCOVERY_AND_RESUME,
    actions: ["identify", "show_anyway", "place_as", "hide"],
    words: () => "Not identified: nothing knows what this file is",
  },
  {
    code: "scheduled",
    holds: (f) => !!f.scheduled,
    needsYou: () => false,
    hidesIn: ALL,
    actions: ["release_now"],
    words: (f) => (f.scheduled?.releaseAt ? `Coming ${shortDate(f.scheduled.releaseAt)}` : "Scheduled for later"),
  },
  {
    code: "special_feature",
    holds: (f) => !!f.specialFeature,
    // Marked but shown with nothing: nobody can reach it except by link.
    needsYou: (f) => f.specialFeature?.mapped === false,
    hidesIn: ALL_BUT_RESUME,
    actions: ["place_as"],
    words: (f) => (f.specialFeature?.of ? `Extras for ${f.specialFeature.of}` : "A special feature, shown with nothing yet"),
  },
  {
    code: "version",
    holds: (f) => !!f.alternateVersion,
    needsYou: () => false,
    hidesIn: ALL_BUT_RESUME,
    actions: ["place_as"],
    words: (f) => {
      const v = f.alternateVersion!;
      const what = v.label || "Another cut";
      return v.of ? `${what} of ${v.of}` : what;
    },
  },
  {
    code: "episode",
    holds: (f) => !!f.group,
    needsYou: () => false,
    hidesIn: NOWHERE, // folded into the show's one tile later, not hidden here
    actions: ["place_as"],
    words: (f) => `In ${f.group!.groupName}`,
  },
  {
    code: "duplicate",
    holds: (f) => !!f.duplicate,
    needsYou: () => true,
    hidesIn: NOWHERE,
    actions: ["hide", "place_as"],
    words: (f) => (f.duplicate?.copies && f.duplicate.copies > 1 ? `Duplicate: ${f.duplicate.copies} copies` : "Duplicate"),
  },
  {
    code: "damaged_allowed",
    holds: (f) => !!f.damaged && f.damaged.allowed,
    needsYou: () => false,
    hidesIn: NOWHERE,
    actions: ["take_off", "replace_recheck"],
    words: (f) => (f.damaged?.detail ? `Shown despite damage: ${f.damaged.detail}` : "Shown despite damage"),
  },
];

/**
 * A question someone has already answered another way does not want them
 * again. A file the curator hid is out of the inbox whatever else holds (the
 * console has always skipped excluded files). Putting a file in a show
 * answers "what is this?", so its missing metadata or a same-named copy is
 * not asked about; a damaged episode still is.
 */
const SILENCED_BY_GROUP: ReadonlySet<ReasonCode> = new Set(["no_metadata", "identifying", "duplicate"]);

function silenced(code: ReasonCode, f: CatalogueFacts): boolean {
  if (code !== "excluded" && f.excluded) return true;
  return !!f.group && SILENCED_BY_GROUP.has(code);
}

const PLACING: ReadonlySet<ReasonCode> = new Set(["special_feature", "version", "episode"]);
const HOLDING: ReadonlySet<ReasonCode> = new Set(["excluded", "scheduled"]);

/** The one function: every reason that holds, and what they add up to. */
export function deriveCatalogueState(facts: CatalogueFacts): CatalogueState {
  const reasons: Reason[] = [];
  for (const rule of RULES) {
    if (!rule.holds(facts)) continue;
    reasons.push({
      code: rule.code,
      words: rule.words(facts),
      needsYou: rule.needsYou(facts) && !silenced(rule.code, facts),
      hidesIn: rule.hidesIn,
      actions: rule.actions,
    });
  }

  const hidesInDiscovery = (r: Reason) => r.hidesIn.includes("discovery");
  let state: CatalogueStateName = "visible";
  if (reasons.some((r) => r.needsYou && hidesInDiscovery(r) && r.code !== "identifying")) state = "needs_decision";
  else if (reasons.some((r) => r.needsYou && r.code === "identifying")) state = "identifying";
  else if (reasons.some((r) => HOLDING.has(r.code))) state = "held";
  else if (reasons.some((r) => PLACING.has(r.code))) state = "placed";

  return {
    state,
    reasons,
    placement: placementOf(facts),
    needsYou: reasons.some((r) => r.needsYou),
  };
}

function placementOf(f: CatalogueFacts): Placement {
  if (f.alternateVersion) return { as: "version", of: f.alternateVersion.of ?? null, label: f.alternateVersion.label ?? null };
  if (f.specialFeature) return { as: "special_feature", of: f.specialFeature.of ?? null };
  if (f.group) return { as: "episode", groupId: f.group.groupId, groupName: f.group.groupName };
  return { as: "film" };
}

/** Whether the file may appear in a list of this kind. Per-viewer rules (parental control) come on top. */
export function isListed(state: CatalogueState, context: ListContext): boolean {
  return !state.reasons.some((r) => r.hidesIn.includes(context));
}

/** The reason a person should hear first, or null for a file that is simply listed. */
export function primaryReason(state: CatalogueState): Reason | null {
  return state.reasons[0] ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "21 Oct", in UTC, so a server and a test agree. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
