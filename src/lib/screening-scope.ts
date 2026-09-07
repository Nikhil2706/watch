/**
 * What a screening identity is allowed to ask Jellyfin for.
 *
 * ======================================================================
 * THIS IS AN ALLOW-LIST AND IT MUST STAY ONE.
 *
 * The rest of /jf/* is a deny-list, and that is correct for members: the
 * real boundary there is the Jellyfin account policy, and the path list is
 * defence in depth. For a screening identity that reasoning collapses.
 * Screenings borrow one shared Jellyfin service account, and
 * applyRestrictedPolicy() sets EnableAllFolders: true — so at the Jellyfin
 * level that account can see the entire library, and Jellyfin has no concept
 * of item-level permission to lean on. The gate is the only thing standing
 * between a screening link and everything on the shelf.
 *
 * If anyone ever implements screening scoping by adding entries to
 * DENIED_PATHS instead, the screening link silently becomes a full library
 * account. Default-deny, explicit allow, item id checked on every rule that
 * can carry one.
 * ======================================================================
 *
 * Pure and free of server-only so the whole table below can be tested — the
 * design asks specifically for a unit test over path strings, asserting both
 * that every permitted shape passes with the right item id and that it fails
 * with a different one.
 *
 * Paths arrive already percent-decoded, lowercased, and traversal-checked by
 * proxy(); this module assumes that and does not repeat it.
 */

/** Jellyfin item ids are 32 hex characters. Anything else is not an id. */
const ITEM_ID = "[0-9a-f]{32}";

/**
 * Rules that are scoped to the screening's own item. `{id}` is substituted
 * with the specific item id, so a rule can never match a different film.
 */
const ITEM_SCOPED: readonly RegExp[] = [
  // The playback plan.
  /^items\/\{id\}\/playbackinfo$/,
  // Direct play, with or without a container extension.
  /^videos\/\{id\}\/stream(\.[a-z0-9]+)?$/,
  // Transcode: the item id is in the path, so it is matchable.
  /^videos\/\{id\}\/main\.m3u8$/,
  /^videos\/\{id\}\/master\.m3u8$/,
  /^videos\/\{id\}\/hls1\/[^/]+\/[^/]+$/,
  /^videos\/\{id\}\/hls\/[^/]+\/[^/]+$/,
  // Subtitle tracks: /Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt
  /^videos\/\{id\}\/[0-9a-z-]+\/subtitles\/\d+\/(stream|[0-9.]+\/stream)\.(vtt|srt|ass|ssa)$/,
  // Poster and backdrop for the landing card.
  /^items\/\{id\}\/images\/[a-z]+(\/\d+)?$/,
] as const;

/**
 * Rules that carry no item id at all.
 *
 * Sessions/Playing* is the honest exception in this design. Its ItemId lives
 * in the request *body*, which a path allow-list cannot see, so a screening
 * viewer could write play state onto the shared service account for some other
 * item. That is a write-only scribble on an account nobody reads, it reveals
 * nothing to the writer, and validating bodies here would mean buffering every
 * video request. It is allowed deliberately.
 *
 * Do not "fix" this into a body parser on the video path.
 */
const UNSCOPED: readonly RegExp[] = [
  /^sessions\/playing$/,
  /^sessions\/playing\/progress$/,
  /^sessions\/playing\/stopped$/,
] as const;

function scopedTo(pattern: RegExp, itemId: string): RegExp {
  return new RegExp(pattern.source.replace("\\{id\\}", itemId));
}

/**
 * May a screening for `allowedItemIds` fetch `path`?
 *
 * @param path   percent-decoded, lowercased, no leading slash — exactly what
 *               proxy() has already computed.
 * @param allowedItemIds the Jellyfin item ids this screening covers. A
 *               screening is usually one film, but screening_items is a table
 *               so a double bill or a grouped set works without changing this.
 */
export function isPermittedForScreening(path: string, allowedItemIds: readonly string[]): boolean {
  // Defence in depth: proxy() checks this first, but this function is the
  // security boundary for an identity that Jellyfin itself does not scope, so
  // it does not rely on being called correctly.
  if (path.includes("..")) return false;

  for (const rule of UNSCOPED) {
    if (rule.test(path)) return true;
  }

  for (const rawId of allowedItemIds) {
    const id = rawId.toLowerCase();
    // A malformed id must never be interpolated into a regex — an id of ".*"
    // would turn every scoped rule into a wildcard over the whole library.
    if (!new RegExp(`^${ITEM_ID}$`).test(id)) continue;
    for (const rule of ITEM_SCOPED) {
      if (scopedTo(rule, id).test(path)) return true;
    }
  }

  return false;
}
