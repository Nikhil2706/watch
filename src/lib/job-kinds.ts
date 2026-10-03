import "server-only";

/**
 * What a scheduled job can do. One entry per kind: its name in the console,
 * what it needs to be told, where it runs, and the work itself.
 *
 * The work is imported lazily inside each `run`. This module is read by the
 * console's job list on every load, and by the boot-time scheduler loop; the
 * scrapers, the TMDB store and the library scan should load when a job of
 * that kind actually runs, not before.
 *
 * A "host" kind is not run here at all. The site lives in a container and
 * cannot start a script on the machine around it, so those are handed to
 * scripts/host-jobs.sh, which asks what is due and reports back. Its list of
 * what it may run is fixed in that script: a kind's name is all that ever
 * crosses from the database to a command line.
 */

export interface JobParamField {
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
}

export interface JobKind {
  kind: string;
  label: string;
  description: string;
  runner: "gate" | "host";
  /** What the console asks for when creating one. */
  params?: JobParamField[];
  /** Whether "wait while someone is watching" is on for a new job of this kind. */
  politeByDefault: boolean;
  /** Returns one line saying what happened, for the run history. */
  run?: (params: Record<string, string>) => Promise<string>;
  /** A label for one job of this kind, from its settings: "Scrape Bright Wall/Dark Room". */
  title?: (params: Record<string, string>) => string;
}

const REVIEW_SOURCES = [
  { value: "ringer", label: "The Ringer (reviews)" },
  { value: "brightwalldarkroom", label: "Bright Wall/Dark Room" },
  { value: "bordwell", label: "David Bordwell" },
  { value: "reverseshot", label: "Reverse Shot" },
];

/** Enough to mean "everything there is": the scrapers stop at what the site has. */
const NO_LIMIT = 100_000;

const KINDS: JobKind[] = [
  {
    kind: "scrape_reviews",
    label: "Scrape a review site",
    description: "Fetches articles the site has published since the last run. Stored articles are left alone.",
    runner: "gate",
    politeByDefault: false,
    params: [{ name: "source", label: "Site", options: REVIEW_SOURCES }],
    title: (p) => `Scrape ${REVIEW_SOURCES.find((s) => s.value === p.source)?.label ?? p.source}`,
    run: async (p) => {
      if (p.source === "ringer") {
        const { runRingerScrape } = await import("./scraping/ringer");
        const r = await runRingerScrape(NO_LIMIT, true);
        return `${r.reviewsProcessed} new reviews, ${r.matchedCount} matched to the library`;
      }
      if (p.source === "brightwalldarkroom") {
        const { runBwdrScrape } = await import("./scraping/brightwalldarkroom");
        const r = await runBwdrScrape(NO_LIMIT, true);
        return `${r.articlesProcessed} new essays, ${r.matchedCount} matched to the library`;
      }
      if (p.source === "bordwell") {
        const { runBordwellScrape } = await import("./scraping/bordwell");
        const r = await runBordwellScrape(NO_LIMIT, true);
        return `${r.postsProcessed} new posts, ${r.matchedCount} matched to the library`;
      }
      if (p.source === "reverseshot") {
        const { runReverseShotScrape } = await import("./scraping/reverseshot");
        const r = await runReverseShotScrape(NO_LIMIT, true);
        return `${r.reviewsProcessed} new reviews, ${r.matchedCount} matched to the library`;
      }
      throw new Error(`Unknown review site: ${p.source}`);
    },
  },
  {
    kind: "ringer_lists",
    label: "Scrape The Ringer's film lists",
    description: "Reads the film articles not yet looked at and keeps the ones that are lists, with each entry's text.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { runRingerListScrape } = await import("./scraping/ringer-lists");
      const r = await runRingerListScrape(NO_LIMIT);
      return `${r.checked} articles read, ${r.listsFound} new lists, ${r.matchedCount} films matched`;
    },
  },
  {
    kind: "yearend_lists",
    label: "Scrape year-end lists",
    description: "This year's and last year's lists from yearendlists.com. Lists already stored are skipped.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { runYearendlistsScrape } = await import("./scraping/yearendlists");
      const year = new Date().getFullYear();
      let lists = 0;
      let matched = 0;
      for (const y of [year, year - 1]) {
        const r = await runYearendlistsScrape(y);
        lists += r.listsProcessed;
        matched += r.matchedCount;
      }
      return `${lists} new lists, ${matched} films matched`;
    },
  },
  {
    kind: "catchup",
    label: "Ratings, Wikipedia and content notes catch-up",
    description: "Fills in OMDb ratings, Wikipedia material and content notes for titles that do not have them yet.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { runFullScrapePass } = await import("./scrape-schedule");
      const r = await runFullScrapePass();
      return `OMDb ${r.omdbProcessed}, Wikipedia ${r.wikipediaProcessed}, content notes ${r.contentWarningsProcessed}`;
    },
  },
  {
    kind: "tmdb_refresh",
    label: "TMDB refresh",
    description: "Re-fetches the oldest part of the TMDB cache, picks up new library titles, and applies episode stills.",
    runner: "gate",
    politeByDefault: true,
    run: async () => {
      const { runTmdbBackfillTick, runTmdbRefreshTick } = await import("./tmdb-backfill");
      const { ingestAllFromCache } = await import("./tmdb-people");
      const { syncTmdbFranchises } = await import("./scraping/film-series");
      const { applyEpisodeStills } = await import("./episode-stills");

      // A slice, not the whole store: this host's link to TMDB drops about one
      // request in thirty, and four passes of sixty turn the store over in
      // under a fortnight. The numbers are the old weekly cron script's.
      let refreshed = 0;
      for (let pass = 0; pass < 4; pass++) {
        const r = await runTmdbRefreshTick(7, 60);
        refreshed += r.refreshed;
        if (r.refreshed === 0) break;
      }
      if (refreshed > 0) ingestAllFromCache();

      const added = await runTmdbBackfillTick(60);
      await syncTmdbFranchises(20).catch((error) => console.error("[jobs] franchise sync failed:", error));
      const stills = await applyEpisodeStills({ budget: 100 });
      return `${refreshed} refreshed, new titles: ${JSON.stringify(added).slice(0, 120)}, stills: ${JSON.stringify(stills).slice(0, 120)}`;
    },
  },
  {
    kind: "library_scan",
    label: "Library scan",
    description: "Asks Jellyfin to look for added and removed files, then links any list entries waiting on them.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { scanLibraryNow } = await import("./library-scan");
      const r = await scanLibraryNow();
      return `scan started, ${r.subtitlesPromoted} subtitle files put in place`;
    },
  },
  {
    kind: "rotate_blurbs",
    label: "Rotate blurbs",
    description: "Gives each film a different blurb from its scraped passages. Films you have chosen a blurb for are not touched.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { rotateBlurbs } = await import("./rotation");
      const r = rotateBlurbs();
      return `${r.changed} of ${r.films} films changed blurb`;
    },
  },
  {
    kind: "rotate_accolades",
    label: "Rotate accolades",
    description: "Moves each film with several accolades on to its next one. Films you have chosen an accolade for are not touched.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { rotateAccolades } = await import("./rotation");
      const r = rotateAccolades();
      return `${r.changed} of ${r.films} films changed accolade`;
    },
  },
  {
    kind: "backup",
    label: "Backup",
    description: "Copies the database and settings to the backup disk. Runs on the computer itself, outside the site.",
    runner: "host",
    politeByDefault: true,
  },
];

export function listJobKinds(): JobKind[] {
  return KINDS;
}

export function getJobKind(kind: string): JobKind | undefined {
  return KINDS.find((k) => k.kind === kind);
}

/** Drops anything a kind does not ask for, and anything not among its options. */
export function cleanParams(kind: JobKind, raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const field of kind.params ?? []) {
    const value = given[field.name];
    if (typeof value === "string" && field.options.some((o) => o.value === value)) out[field.name] = value;
  }
  return out;
}

export function missingParam(kind: JobKind, params: Record<string, string>): string | null {
  for (const field of kind.params ?? []) if (!params[field.name]) return `Choose: ${field.label}.`;
  return null;
}

/**
 * Things that run on their own every few minutes and are not schedulable:
 * each is part of a feature working at all, and "every Thursday" would break
 * it. Listed so the Jobs card accounts for everything that runs.
 */
export const ALWAYS_ON: Array<{ label: string; every: string; where: string }> = [
  { label: "New film, show and episode notifications", every: "10 minutes", where: "the site" },
  { label: "Starting scheduled watch parties", every: "1 minute", where: "the site" },
  { label: "Revealing scheduled episodes", every: "10 minutes", where: "the site" },
  { label: "Removing expired screenings", every: "1 hour", where: "the site" },
  { label: "Converting new films in the watch folder", every: "continuously", where: "the worker" },
  { label: "Freeing unused memory", every: "5 minutes", where: "this computer" },
  { label: "Starting the site and the tunnel", every: "when you sign in to Windows", where: "this computer" },
];
