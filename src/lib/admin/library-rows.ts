/**
 * The Library tab's data shaping, ported from curator.html's workspace
 * (lwBuildRows, LW_REASONS, LW_FILTERS, lwVisibleRows and friends) so /admin
 * behaves the same and is tested. No React, no fetch: the workspace component
 * holds the state and calls these.
 *
 * One list, from /api/admin/library/browse. A show is ONE row, the way it is
 * one tile on the site, and its flags are the union of its episodes'. The
 * special-feature marks and suggestions are merged on top, because an
 * unconfirmed suggestion is exactly what "Needs you" means.
 */

import type { BrowseItem } from "../library-review";

export type LibraryItem = BrowseItem;

export interface FeatureTarget {
  kind: string;
  targetId: string;
  targetLabel?: string | null;
}
export interface SpecialFeature {
  itemId: string;
  targets: FeatureTarget[];
}
export interface FeatureGuess {
  itemId: string;
  confidence: number;
  reasons: string[];
  targets: Array<FeatureTarget & { reason?: string }>;
}

interface RowFlags {
  needsDecision: boolean;
  isDuplicate: boolean;
  isThinMetadata: boolean;
  isMissingSubtitles: boolean;
  isDamaged: boolean;
  isWhitelisted: boolean;
  isExcluded: boolean;
}

export interface FilmRow extends RowFlags {
  kind: "film";
  id: string;
  item: LibraryItem;
  name: string;
  year: number | null;
  poster: string | null;
  pendingEpisode: LibraryItem["pendingEpisode"];
  isSpecialFeature: boolean;
  /** A special feature that is hidden but shown on nothing. */
  isUnmappedFeature: boolean;
  featureGuess: FeatureGuess | null;
  /** How many rows collapsed into this one (duplicate copies, loose episodes of one series). */
  dupCount?: number;
}

export interface ShowRow extends RowFlags {
  kind: "show";
  id: string;
  groupId: string;
  name: string;
  year: null;
  poster: string | null;
  members: LibraryItem[];
  dupCount?: number;
}

export type Row = FilmRow | ShowRow;

/**
 * A file saved from a URL keeps its escapes ("Kindl %28Farocki%29.mp4"), and
 * with no metadata Jellyfin's name is the filename. Shown decoded; the path
 * stays exactly as it is on disk.
 */
export function readableName(name: string): string {
  if (!name || !/%[0-9A-Fa-f]{2}/.test(name)) return name;
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function isDamagedOff(it: Pick<LibraryItem, "damage" | "damageAllowed">): boolean {
  return Boolean(it.damage && it.damage.verdict === "damaged" && !it.damageAllowed);
}

export function filmRow(
  it: LibraryItem,
  features: Readonly<Record<string, SpecialFeature>> = {},
  guesses: Readonly<Record<string, FeatureGuess>> = {},
): FilmRow {
  const feature = features[it.id];
  const guess = feature ? null : (guesses[it.id] ?? null);
  const isUnmappedFeature = Boolean(feature && feature.targets.length === 0);
  return {
    kind: "film",
    id: it.id,
    item: it,
    name: readableName(it.name),
    year: it.year,
    poster: it.posterUrl,
    // Both genuinely want a person: an unconfirmed suggestion, and a feature
    // that is hidden but appears nowhere.
    needsDecision: it.needsDecision || Boolean(guess) || isUnmappedFeature,
    isDuplicate: it.isDuplicate,
    isThinMetadata: it.isThinMetadata,
    isMissingSubtitles: it.isMissingSubtitles,
    isDamaged: isDamagedOff(it),
    isWhitelisted: it.isWhitelisted,
    isExcluded: it.isExcluded,
    pendingEpisode: it.pendingEpisode ?? null,
    isSpecialFeature: Boolean(feature),
    isUnmappedFeature,
    featureGuess: guess,
  };
}

/** Every row, in listing order: films as themselves, each show once with all its files. */
export function buildRows(
  items: readonly LibraryItem[],
  features: Readonly<Record<string, SpecialFeature>> = {},
  guesses: Readonly<Record<string, FeatureGuess>> = {},
): Row[] {
  const rows: Row[] = [];
  const groups = new Map<string, ShowRow>();
  for (const it of items) {
    if (it.isGrouped && it.groupId) {
      let g = groups.get(it.groupId);
      if (!g) {
        g = {
          kind: "show",
          id: `group:${it.groupId}`,
          groupId: it.groupId,
          name: it.groupName || "Untitled show",
          year: null,
          poster: null,
          members: [],
          needsDecision: false,
          isDuplicate: false,
          isThinMetadata: false,
          isMissingSubtitles: false,
          isDamaged: false,
          isWhitelisted: false,
          isExcluded: false,
        };
        groups.set(it.groupId, g);
        rows.push(g);
      }
      g.members.push({ ...it, name: readableName(it.name) });
      if (!g.poster && it.posterUrl) g.poster = it.posterUrl;
      if (it.isThinMetadata && !it.isWhitelisted) g.isThinMetadata = true;
      if (it.isMissingSubtitles) g.isMissingSubtitles = true;
      // One broken episode is the show's problem to surface.
      if (isDamagedOff(it)) {
        g.isDamaged = true;
        g.needsDecision = true;
      }
      continue;
    }
    rows.push(filmRow(it, features, guesses));
  }
  return rows;
}

/** WHY a row wants attention: the sub-chips under Needs you. */
export const REASONS = [
  { key: "meta", label: "No metadata", test: (r: Row) => r.isThinMetadata && !r.isWhitelisted },
  { key: "damaged", label: "Damaged file", test: (r: Row) => r.isDamaged },
  // Recognised as an episode and in no show: off the site until grouped, or kept as a film.
  { key: "episode", label: "Episode, not in a show", test: (r: Row) => r.kind === "film" && Boolean(r.pendingEpisode) },
  { key: "dup", label: "Duplicate", test: (r: Row) => r.isDuplicate },
  { key: "guess", label: "Might be a special feature", test: (r: Row) => r.kind === "film" && Boolean(r.featureGuess) },
  { key: "unmapped", label: "Feature, not shown anywhere", test: (r: Row) => r.kind === "film" && r.isUnmappedFeature },
] as const;
export type ReasonKey = (typeof REASONS)[number]["key"];

export function reasonsFor(r: Row): Array<(typeof REASONS)[number]> {
  if (r.kind !== "film") return [];
  return REASONS.filter((x) => x.test(r));
}

export const FILTERS = [
  { key: "needs", label: "Needs you", alert: true, test: (r: Row) => r.needsDecision },
  { key: "dup", label: "Duplicates", alert: true, test: (r: Row) => r.isDuplicate },
  { key: "nometa", label: "No metadata", alert: true, test: (r: Row) => r.isThinMetadata && !r.isWhitelisted },
  // A file the worker read through and found broken: off the site until replaced or shown anyway.
  { key: "damaged", label: "Damaged", alert: true, test: (r: Row) => r.isDamaged },
  { key: "nosubs", label: "No subtitles", alert: false, test: (r: Row) => r.isMissingSubtitles },
  { key: "shows", label: "Shows", alert: false, test: (r: Row) => r.kind === "show" },
  { key: "hidden", label: "Hidden", alert: false, test: (r: Row) => r.isExcluded },
  { key: "special", label: "Special features", alert: false, test: (r: Row) => r.kind === "film" && r.isSpecialFeature },
  { key: "all", label: "Everything", alert: false, test: () => true },
] as const;
export type FilterKey = (typeof FILTERS)[number]["key"];

function activeFilters(keys: readonly FilterKey[]) {
  return FILTERS.filter((f) => f.key !== "all" && keys.includes(f.key));
}

/**
 * Duplicates are a pair, not two problems; sixteen loose episodes of one
 * series are one decision. One row per key, carrying how many it stands for.
 */
export function dupKey(r: Row): string | null {
  if (r.kind !== "film") return null;
  if (r.pendingEpisode) return `ep:${r.pendingEpisode.key}`;
  return r.isDuplicate ? `dup:${r.name.toLowerCase()}` : null;
}

export function collapseDuplicates(rows: readonly Row[]): Row[] {
  const seen = new Map<string, Row>();
  const out: Row[] = [];
  for (const r of rows) {
    const key = dupKey(r);
    if (!key) {
      out.push(r);
      continue;
    }
    const head = seen.get(key);
    if (head) {
      head.dupCount = (head.dupCount ?? 1) + 1;
      continue;
    }
    const copy = { ...r, dupCount: 1 } as Row;
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

/** Title, filename (the way back from a wrong match) or year. */
export function matchesQuery(row: Row, q: string): boolean {
  if (!q) return true;
  if (row.name.toLowerCase().includes(q)) return true;
  const paths = row.kind === "show" ? row.members.map((m) => m.path ?? "") : [row.item.path ?? ""];
  if (paths.some((p) => p.toLowerCase().includes(q))) return true;
  return row.year !== null && String(row.year).includes(q);
}

export const SORTS = [
  { key: "needs", label: "Needs you first" },
  { key: "name", label: "Title A–Z" },
  { key: "year", label: "Newest film first" },
  { key: "yearold", label: "Oldest film first" },
  { key: "size", label: "Biggest file first" },
  { key: "res", label: "Lowest resolution first" },
] as const;
export type SortKey = (typeof SORTS)[number]["key"];

export interface ViewState {
  query: string;
  filters: readonly FilterKey[];
  reason: ReasonKey | null;
  sort: SortKey;
}

export function visibleRows(rows: readonly Row[], view: ViewState): Row[] {
  const q = view.query.trim().toLowerCase();
  const active = activeFilters(view.filters);
  let out = rows.filter((r) => active.every((f) => f.test(r)) && matchesQuery(r, q));
  if (view.filters.includes("needs") && view.reason) {
    out = out.filter((r) => reasonsFor(r).some((x) => x.key === view.reason));
  }
  out = collapseDuplicates(out);

  // A show has no single year, size or resolution: shows keep their place by
  // name at the end of the file-shaped sorts.
  const num = (r: Row, pick: (i: LibraryItem) => number | null | undefined): number | null => {
    if (r.kind !== "film") return null;
    const v = pick(r.item);
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const by = (pick: (i: LibraryItem) => number | null | undefined, dir: 1 | -1) => (a: Row, b: Row) => {
    const x = num(a, pick);
    const y = num(b, pick);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    return x === y ? a.name.localeCompare(b.name) : (x - y) * dir;
  };
  switch (view.sort) {
    case "name":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    case "year":
      return out.sort(by((i) => i.year, -1));
    case "yearold":
      return out.sort(by((i) => i.year, 1));
    case "size":
      return out.sort(by((i) => i.sizeBytes, -1));
    case "res":
      return out.sort(by((i) => i.height, 1));
    default:
      return out.sort((a, b) => (a.needsDecision !== b.needsDecision ? (a.needsDecision ? -1 : 1) : a.name.localeCompare(b.name)));
  }
}

export interface Chip {
  key: FilterKey;
  label: string;
  count: number;
  on: boolean;
  alert: boolean;
}

/**
 * Each facet counted against the OTHER active facets, so with Shows on, "No
 * subtitles 3" means three shows — the number clicking it would give.
 * Collapsed like the rail, so a duplicated title counts once.
 */
export function filterChips(rows: readonly Row[], filters: readonly FilterKey[]): Chip[] {
  return FILTERS.map((f) => {
    const others = activeFilters(filters).filter((x) => x.key !== f.key);
    const base = rows.filter((r) => others.every((x) => x.test(r)));
    const count = collapseDuplicates(f.key === "all" ? base : base.filter(f.test)).length;
    const on = f.key === "all" ? filters.length === 0 : filters.includes(f.key);
    return { key: f.key, label: f.label, count, on, alert: f.alert && count > 0 };
  });
}

/** The "because:" row under Needs you; empty when Needs you is off or nothing needs anything. */
export function reasonChips(
  rows: readonly Row[],
  filters: readonly FilterKey[],
  reason: ReasonKey | null,
): Array<{ key: ReasonKey; label: string; count: number; on: boolean }> {
  if (!filters.includes("needs")) return [];
  const needing = rows.filter((r) => r.needsDecision);
  return REASONS.map((x) => ({
    key: x.key,
    label: x.label,
    count: collapseDuplicates(needing.filter(x.test)).length,
    on: reason === x.key,
  })).filter((c) => c.count > 0);
}

/** Clicking a facet: "Everything" clears them all; a reason only means anything under Needs you. */
export function toggleFilter(
  state: { filters: readonly FilterKey[]; reason: ReasonKey | null },
  key: FilterKey,
): { filters: FilterKey[]; reason: ReasonKey | null } {
  let filters: FilterKey[];
  if (key === "all") filters = [];
  else filters = state.filters.includes(key) ? state.filters.filter((k) => k !== key) : [...state.filters, key];
  return { filters, reason: filters.includes("needs") ? state.reason : null };
}

/** A second click on the active reason clears it, so the whole pile is one click back. */
export function toggleReason(current: ReasonKey | null, key: ReasonKey): ReasonKey | null {
  return current === key ? null : key;
}

export type Dot = "danger" | "warn" | "dead" | "accent" | "";

export function stateDot(row: Row): Dot {
  if (row.isExcluded) return "danger";
  if (row.isThinMetadata && !row.isWhitelisted) return "warn";
  if (row.isDuplicate) return "warn";
  if (row.isMissingSubtitles) return "dead";
  if (row.kind === "show") return "accent";
  return "";
}

/** The second line under a row's name in the rail. */
export function railSub(r: Row, view: Pick<ViewState, "filters" | "reason">): string {
  let sub: string;
  if (r.kind === "show") sub = `${r.members.length} files`;
  else if (r.pendingEpisode) {
    const pe = r.pendingEpisode;
    sub = `${pe.files} episode${pe.files === 1 ? "" : "s"} of ${pe.name}, in no show`;
  } else if ((r.dupCount ?? 1) > 1) sub = `${r.dupCount} copies${r.year ? ` · ${r.year}` : ""}`;
  else sub = r.year ? String(r.year) : "";
  // In the undifferentiated Needs-you pile, say what each row wants.
  if (view.filters.includes("needs") && !view.reason) {
    const why = reasonsFor(r)
      .map((x) => x.label)
      .join(" · ");
    if (why) sub = sub ? `${sub} · ${why}` : why;
  }
  return sub;
}

/** "Group as <series>", or "Add to <show>" when a show for that series exists. */
export function groupEpisodesLabel(pe: NonNullable<LibraryItem["pendingEpisode"]>): string {
  return (pe.joins ? "Add to " : "Group as ") + pe.name;
}

export function statusLine(it: LibraryItem): string {
  const bits: string[] = [];
  if (it.isExcluded) bits.push("Hidden from the site");
  if (it.isThinMetadata && !it.isWhitelisted) bits.push("No metadata fetched — hidden until fixed");
  if (it.isThinMetadata && it.isWhitelisted) bits.push("No metadata, shown anyway");
  if (it.damage) {
    bits.push(
      it.damage.verdict === "damaged"
        ? (it.damageAllowed ? "Damaged file, shown anyway: " : "Damaged file — off the site until replaced: ") + it.damage.detail
        : `Small fault in the file, still shown: ${it.damage.detail}`,
    );
  }
  if (it.isDuplicate) bits.push("Duplicate title");
  if (it.pendingEpisode) bits.push(`Episode of ${it.pendingEpisode.name}, in no show — off the site until grouped`);
  if (it.version) bits.push(it.version.isPrimary ? `Main of ${it.version.setSize} cuts` : `Cut: ${it.version.label}`);
  if (it.isMissingSubtitles) bits.push("No subtitles");
  if (!bits.length) bits.push("Nothing needs deciding");
  return bits.join(" · ");
}

/**
 * The selected row, or — for an episode, which is not a row of its own but
 * lives inside its show — a film row for that file, so "Open" on an episode
 * reaches its own buttons (damaged file, subtitles, poster). PR #21's fix.
 */
export function rowById(rows: readonly Row[], items: readonly LibraryItem[], id: string | null): Row | null {
  if (!id) return null;
  const row = rows.find((r) => r.id === id);
  if (row) return row;
  const it = items.find((i) => i.id === id);
  return it ? filmRow(it) : null;
}

/** Which episodes made a show "Damaged" (only those are off the site), and which have no subtitles. PR #21. */
export function memberMarks(m: LibraryItem): { damage: "damaged" | "damaged, shown" | null; noSubs: boolean } {
  const damage = m.damage && m.damage.verdict === "damaged" ? (m.damageAllowed ? "damaged, shown" : "damaged") : null;
  return { damage, noSubs: m.isMissingSubtitles };
}

/** The copies of a duplicated film, side by side, and the highest-resolution one. */
export function duplicateCopies(rows: readonly Row[], row: Row): { copies: FilmRow[]; bestId: string | null } {
  const name = row.name.toLowerCase();
  const copies = rows.filter((r): r is FilmRow => r.kind === "film" && r.isDuplicate && r.name.toLowerCase() === name);
  if (copies.length < 2) return { copies: [], bestId: null };
  let best: FilmRow | null = null;
  for (const c of copies) if (!best || (c.item.height ?? 0) > (best.item.height ?? 0)) best = c;
  return { copies, bestId: best?.id ?? null };
}

export function copySpecs(it: LibraryItem): string {
  const specs = [it.height ? `${it.height}p` : "resolution unknown"];
  const size = formatBytes(it.sizeBytes);
  if (size) specs.push(size);
  specs.push(it.subtitleCount ? `${it.subtitleCount} subtitle tracks` : "no subtitles");
  return specs.join(" · ");
}

export function formatBytes(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export function shortPath(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 3 ? `.../${parts.slice(-2).join("/")}` : p;
}

export function scannedAgo(ts: number | null, now: number): string {
  if (!ts) return "never scanned";
  const mins = Math.round((now - ts) / 60000);
  if (mins < 1) return "scanned just now";
  if (mins < 60) return `scanned ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `scanned ${hrs}${hrs === 1 ? " hour ago" : " hours ago"}`;
  const days = Math.round(hrs / 24);
  return `scanned ${days}${days === 1 ? " day ago" : " days ago"}`;
}

/**
 * The single-file actions done to many ticked rows at once. Hide and show are
 * keyed on the FILE PATH (the curation layer is path-keyed, because Jellyfin
 * ids do not survive a rebuild); only fetching subtitles takes an id. Getting
 * this wrong fails quietly per file, hence its own tested function.
 */
export type BulkAction = "hide" | "whitelist" | "subs";

export function bulkRequest(
  action: BulkAction,
  it: Pick<LibraryItem, "id" | "path">,
): { url: string; body: Record<string, string> } | null {
  switch (action) {
    case "hide":
      return it.path ? { url: "/api/admin/library/exclude", body: { path: it.path } } : null;
    case "whitelist":
      return it.path ? { url: "/api/admin/library/whitelist", body: { path: it.path } } : null;
    case "subs":
      return { url: "/api/admin/library/fetch-subtitles", body: { itemId: it.id } };
  }
}

/** What each bulk action changes on the item, so the list updates without a reload. */
export const BULK_PATCH: Record<BulkAction, Partial<LibraryItem> | null> = {
  hide: { isExcluded: true, needsDecision: false },
  whitelist: { isWhitelisted: true, needsDecision: false },
  subs: null,
};

export const BULK_VERB: Record<BulkAction, string> = {
  hide: "Hide",
  whitelist: "Show anyway on",
  subs: "Fetch subtitles for",
};

/** Patch one item in place: hiding a film changes one flag the client already knows. */
export function patchItems(items: readonly LibraryItem[], id: string, changes: Partial<LibraryItem>): LibraryItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...changes } : i));
}

/** The other copies of a film, for "Keep this one, hide the rest" and "Keep all as versions". */
export function otherCopies(rows: readonly Row[], keeper: Row): FilmRow[] {
  const name = keeper.name.toLowerCase();
  return rows.filter(
    (r): r is FilmRow => r.kind === "film" && r.isDuplicate && r.name.toLowerCase() === name && r.id !== keeper.id,
  );
}

/** What a finished scan found, in the console's words. */
export function scanReport(added: number, needing: number): string {
  const what =
    added > 0
      ? `${added} new file${added === 1 ? "" : "s"} picked up. `
      : added < 0
        ? `${-added} file${added === -1 ? "" : "s"} no longer there. `
        : "Nothing new. ";
  return `${what}${needing} need a decision.`;
}

export function daysUntil(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

/** Release-tag noise stripped, so Identify's search box starts with a plausible title instead of a raw filename. */
export function guessSearchName(name: string): string {
  return name
    .replace(/[._]/g, " ")
    .replace(
      /\b(1080p|2160p|720p|480p|4k|uhd|web[- ]?dl|webrip|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|remux|proper|repack)\b.*$/i,
      "",
    )
    .trim();
}

/** "S01E07" for the subtitle plan's rows. */
export function episodeCode(e: { season: number; episode: number }): string {
  return `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`;
}
