/**
 * One Cast row and one Crew row, merged from the two sources that know things.
 *
 * Jellyfin knows the cast, and has portraits for many of them. It knows
 * Director, Writer and Producer too — and nothing else: across all 1,181 items
 * it holds zero people of type DirectorOfPhotography, Editor, Composer or
 * ProductionDesign. TMDB knows all of those, for 368 titles here, but its
 * people have no Jellyfin id and so no portrait Jellyfin can serve.
 *
 * So neither source alone makes a Crew row. This merges them, and it prefers
 * Jellyfin wherever both know someone — a Jellyfin person can be linked to
 * their own page and already has a photo, which a TMDB-only person cannot and
 * does not.
 *
 * Pure, and with no imports, so the merge can be tested directly: the
 * interesting cases are all about the same human arriving twice under slightly
 * different spellings, which is exactly the sort of thing that is easy to get
 * wrong and invisible until someone appears in a row twice.
 */

/** A person as Jellyfin has them on an item. */
export interface JellyfinPerson {
  Id: string;
  Name: string;
  Role?: string;
  Type: string;
  /** Present only when Jellyfin actually holds a portrait for them. */
  PrimaryImageTag?: string;
}

/** A person as the TMDB credits tables have them. */
export interface TmdbCredit {
  tmdbId: number;
  name: string;
  profilePath: string | null;
  department: string;
  job: string;
  ord: number;
}

export interface CreditCard {
  /** Stable within a row; used as the React key. */
  key: string;
  name: string;
  /** "Mario Livi" for cast, "Director · Screenplay" for crew. Empty is fine. */
  role: string;
  /** Where tapping the card goes, or null when the person has no page. */
  href: string | null;
  /** Which store can serve a portrait, if either can. */
  photo:
    | { kind: "jellyfin"; id: string; tag: string }
    | { kind: "tmdb"; tmdbId: number }
    | null;
  initials: string;
}

/**
 * The Jellyfin person types that are really crew, and what to call them.
 *
 * Producer is here and Actor is not, which is the whole split: everything in
 * this map goes in the Crew row and everything else Jellyfin calls a person
 * goes in Cast.
 */
const JELLYFIN_CREW_JOBS: Record<string, string> = {
  Director: "Director",
  Writer: "Screenplay",
  Producer: "Producer",
  DirectorOfPhotography: "Cinematography",
  Editor: "Editor",
  Composer: "Original music",
  ProductionDesign: "Production design",
};

/** How a stored department reads on a card. */
const DEPARTMENT_LABELS: Record<string, string> = {
  directors: "Director",
  writers: "Screenplay",
  cinematographers: "Cinematography",
  composers: "Original music",
  editors: "Editor",
  productionDesigners: "Production design",
};

/**
 * The order departments appear in, which is a film's own credit order rather
 * than alphabetical or however the database happened to return them.
 */
const DEPARTMENT_ORDER = [
  "directors",
  "writers",
  "cinematographers",
  "editors",
  "composers",
  "productionDesigners",
] as const;

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * Match key for "the same human".
 *
 * Case and accents only. Deliberately not fuzzy: merging two people who merely
 * have similar names would silently drop a real credit, which is worse than
 * showing someone twice, and no amount of cleverness distinguishes a junior
 * from a senior of the same name.
 */
function nameKey(name: string): string {
  return name
    .normalize("NFD")
    // Strip combining accents, so é and e are the same letter — the same
    // class normaliseTitle() uses in match-audit.ts.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Several jobs for one person, in credit order, joined the way a card shows them. */
function joinJobs(jobs: string[]): string {
  const seen: string[] = [];
  for (const job of jobs) if (job && !seen.includes(job)) seen.push(job);
  return seen.join(" · ");
}

export interface MergedCredits {
  cast: CreditCard[];
  crew: CreditCard[];
}

export function mergeCredits(
  people: readonly JellyfinPerson[],
  credits: readonly TmdbCredit[],
  options: { castLimit?: number } = {},
): MergedCredits {
  const castLimit = options.castLimit ?? 20;

  /* ---- Cast: Jellyfin leads, TMDB fills in only who it has never seen ---- */
  const cast: CreditCard[] = [];
  const castSeen = new Set<string>();

  for (const p of people) {
    if (p.Type !== "Actor") continue;
    const key = nameKey(p.Name);
    if (castSeen.has(key)) continue;
    castSeen.add(key);
    cast.push({
      key: `jf-${p.Id}`,
      name: p.Name,
      role: p.Role ?? "",
      href: `/person/${p.Id}`,
      photo: p.PrimaryImageTag ? { kind: "jellyfin", id: p.Id, tag: p.PrimaryImageTag } : null,
      initials: initialsOf(p.Name),
    });
  }

  for (const c of credits) {
    if (c.department !== "cast") continue;
    const key = nameKey(c.name);
    if (castSeen.has(key)) continue;
    castSeen.add(key);
    cast.push({
      key: `tmdb-${c.tmdbId}`,
      name: c.name,
      role: c.job,
      href: `/person/tmdb/${c.tmdbId}`,
      photo: c.profilePath ? { kind: "tmdb", tmdbId: c.tmdbId } : null,
      initials: initialsOf(c.name),
    });
  }

  /* ---- Crew: one card per person, however many jobs they hold ---- */
  interface Draft {
    name: string;
    jobs: string[];
    order: number;
    jellyfinId: string | null;
    jellyfinTag: string | null;
    tmdbId: number | null;
    profilePath: string | null;
  }
  const drafts = new Map<string, Draft>();

  const add = (
    name: string,
    job: string,
    order: number,
    from: {
      jellyfinId?: string;
      jellyfinTag?: string | null;
      tmdbId?: number;
      profilePath?: string | null;
    },
  ): void => {
    const key = nameKey(name);
    const existing = drafts.get(key);
    if (existing) {
      existing.jobs.push(job);
      // Earliest department wins the position, so a director who also edited
      // still sits with the directors.
      existing.order = Math.min(existing.order, order);
      // A Jellyfin identity, once known, is never given up: it is the only one
      // of the two that can be linked and photographed.
      existing.jellyfinId ??= from.jellyfinId ?? null;
      existing.jellyfinTag ??= from.jellyfinTag ?? null;
      existing.tmdbId ??= from.tmdbId ?? null;
      existing.profilePath ??= from.profilePath ?? null;
      return;
    }
    drafts.set(key, {
      name,
      jobs: [job],
      order,
      jellyfinId: from.jellyfinId ?? null,
      jellyfinTag: from.jellyfinTag ?? null,
      tmdbId: from.tmdbId ?? null,
      profilePath: from.profilePath ?? null,
    });
  };

  // Jellyfin first, so it wins the identity for anyone both sources know.
  for (const p of people) {
    const job = JELLYFIN_CREW_JOBS[p.Type];
    if (!job) continue;
    const order = DEPARTMENT_ORDER.findIndex((d) => DEPARTMENT_LABELS[d] === job);
    add(p.Name, job, order === -1 ? DEPARTMENT_ORDER.length : order, {
      jellyfinId: p.Id,
      jellyfinTag: p.PrimaryImageTag ?? null,
    });
  }

  for (const c of credits) {
    if (c.department === "cast") continue;
    const label = DEPARTMENT_LABELS[c.department];
    if (!label) continue;
    const order = DEPARTMENT_ORDER.indexOf(c.department as (typeof DEPARTMENT_ORDER)[number]);
    add(c.name, label, order === -1 ? DEPARTMENT_ORDER.length : order, {
      tmdbId: c.tmdbId,
      profilePath: c.profilePath,
    });
  }

  const crew: CreditCard[] = [...drafts.values()]
    .sort((a, b) => a.order - b.order)
    .map((d) => ({
      key: d.jellyfinId ? `jf-${d.jellyfinId}` : `tmdb-${d.tmdbId}`,
      name: d.name,
      role: joinJobs(d.jobs),
      // Jellyfin's own person page where there is one — it has their
              // portrait and biography. The TMDB page otherwise, which answers
              // the same question from tmdb_credits.
      href: d.jellyfinId ? `/person/${d.jellyfinId}` : d.tmdbId ? `/person/tmdb/${d.tmdbId}` : null,
      photo: d.jellyfinId && d.jellyfinTag
        ? { kind: "jellyfin", id: d.jellyfinId, tag: d.jellyfinTag }
        : d.tmdbId !== null && d.profilePath
          ? { kind: "tmdb", tmdbId: d.tmdbId }
          : null,
      initials: initialsOf(d.name),
    }));

  return { cast: cast.slice(0, castLimit), crew };
}
