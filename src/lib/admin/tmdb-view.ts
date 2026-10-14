/**
 * The TMDB tab's data shaping (step 2e of moving the console). Ported from
 * curator.html (tmdbLoadStats, tmdbRunTick/People/Audit, ages, groups,
 * stills); no React, so it can be tested.
 */

export function tmdbAge(days: number | null | undefined): string {
  if (days == null || Number.isNaN(days)) return "—";
  if (days < 1) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

export function se(x: { season: number; episode: number }): string {
  return `S${String(x.season).padStart(2, "0")}E${String(x.episode).padStart(2, "0")}`;
}

export function baseName(p: string): string {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || String(p);
}

export interface StoreStats {
  movies?: number | null;
  shows?: number | null;
  seasons?: number | null;
  oldestFetch?: number | null;
}

export interface PeopleStats {
  people?: number | null;
  credits?: number | null;
  photoCache?: { count?: number | null; megabytes?: number | null } | null;
}

export function storeCards(store: StoreStats, people: PeopleStats, now: number): Array<{ label: string; value: string; sub: string }> {
  const out: Array<{ label: string; value: string; sub: string }> = [];
  if (store.movies != null) out.push({ label: "Films cached", value: String(store.movies), sub: "" });
  if (store.shows != null) out.push({ label: "Shows", value: String(store.shows), sub: "" });
  if (store.seasons != null) out.push({ label: "Seasons", value: String(store.seasons), sub: "" });
  if (store.oldestFetch) out.push({ label: "Oldest entry", value: tmdbAge(Math.floor((now - store.oldestFetch) / 86400000)), sub: "since it was fetched" });
  out.push({ label: "People", value: people.people != null ? String(people.people) : "—", sub: "" });
  out.push({ label: "Credits", value: people.credits != null ? String(people.credits) : "—", sub: "" });
  const cache = people.photoCache ?? {};
  out.push({
    label: "Photos cached",
    value: cache.count != null ? String(cache.count) : "—",
    sub: cache.megabytes != null ? `${cache.megabytes} MB, filled as pages are viewed` : "",
  });
  return out;
}

export function tickReport(d: {
  moviesFetched?: number;
  seasonsFetched?: number;
  showsLinked?: number;
  failures?: number;
  creditsIngested?: number;
  done?: boolean;
}): string {
  return (
    `Fetched ${d.moviesFetched || 0} films, ${d.seasonsFetched || 0} seasons, linked ${d.showsLinked || 0} shows, ${d.failures || 0} failures` +
    (d.creditsIngested ? `, ${d.creditsIngested} credits rebuilt` : "") +
    (d.done ? " — everything with an IMDb id is cached." : " — press again to continue.")
  );
}

export function peopleReport(d: { subjects?: number; credits?: number; episodePeople?: number }): string {
  return `Read ${d.subjects || 0} titles, wrote ${d.credits || 0} credits${d.episodePeople ? ` and ${d.episodePeople} people from season payloads` : ""}.`;
}

export interface Audit {
  audited: number;
  suspect: number;
  check: number;
  uncached: number;
  confirmed?: number;
  findings: Array<{
    verdict: string;
    libraryTitle: string | null;
    libraryYear: number | null;
    tmdbTitle: string | null;
    tmdbYear: number | null;
    filename: string | null;
    why: string | null;
  }>;
}

export function auditHead(d: Audit): string {
  return `${d.audited} audited · ${d.suspect} suspect · ${d.check} worth a look · ${d.uncached} not cached, so not judged${d.confirmed ? ` · ${d.confirmed} confirmed by hand, not re-judged` : ""}`;
}

export function oldestReport(d: { refreshed?: number; failures?: number; remaining?: number }): string {
  const remaining = d.remaining || 0;
  return `Refreshed ${d.refreshed || 0}, ${d.failures || 0} failed, ${remaining} still over 30 days${remaining > 0 ? " — press again to continue." : "."}`;
}

export interface Group {
  groupId: string;
  name: string;
  files: number;
  kind: string | null;
  link: { tmdbId: number; name: string | null; resolvedBy: string | null } | null;
}

export function groupsHead(groups: readonly Group[]): string {
  const linked = groups.filter((g) => g.link).length;
  const films = groups.filter((g) => !g.link && g.kind === "movie").length;
  return `${groups.length} groups · ${linked} linked · ${groups.length - linked - films} shows not linked · ${films} films in parts, correctly not linked`;
}

export function linkQuestion(group: Pick<Group, "name" | "files">, cand: { name: string; episodes: number | null }): string {
  return (
    `Link "${group.name}" (${group.files} files) to TMDB's "${cand.name}"${cand.episodes != null ? ` (${cand.episodes} episodes)` : ""}?\n\n` +
    "Applying stills trusts this link: a wrong one puts another show's artwork on every episode."
  );
}

export interface StillsPlan {
  alreadyDone?: number;
  planned?: number;
  skipped?: { unparsed?: number; noEpisode?: number; noStill?: number };
  details?: {
    unparsed: string[];
    noEpisode: Array<{ group: string; season: number; episode: number; path: string }>;
    noStill: Array<{ group: string; season: number; episode: number; title: string; path: string }>;
  } | null;
}

export function stillsHead(d: StillsPlan): string {
  const s = d.skipped ?? {};
  return `${d.alreadyDone || 0} already carry TMDB's still · ${d.planned || 0} ready to apply · ${s.unparsed || 0} with no episode number · ${s.noEpisode || 0} numbering mismatches · ${s.noStill || 0} with no still on TMDB`;
}

export function stillsLists(d: StillsPlan): Array<{ title: string; why: string; items: Array<{ main: string; sub: string }> }> {
  const det = d.details;
  if (!det) return [];
  return [
    {
      title: "No season or episode in the filename",
      why: "Nothing can match these until the file carries an S01E02-style marker.",
      items: det.unparsed.map((p) => ({ main: baseName(p), sub: p })),
    },
    {
      title: "TMDB has no such episode",
      why: "Usually a special or a double episode shifting the numbering. Check TMDB's season list before renaming anything.",
      items: det.noEpisode.map((x) => ({ main: `${x.group} · ${se(x)}`, sub: x.path })),
    },
    {
      title: "TMDB has the episode but no still",
      why: "Nothing to fix here; TMDB may gain one later.",
      items: det.noStill.map((x) => ({ main: `${x.group} · ${se(x)} — ${x.title}`, sub: x.path })),
    },
  ].filter((l) => l.items.length > 0);
}
