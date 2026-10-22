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
 * A "worker" kind is not run here either: it needs what only the worker
 * container has (the backup drive, Jellyfin's config), so the worker
 * collects it each cycle and runs it from its own fixed list
 * (scripts/worker-jobs.mjs). Its schedule, and whether to wait while someone
 * is watching, are still decided here.
 *
 * A "loop" kind is the worker's continuous work (conversions, the upload
 * virus scan, the damaged-file check). It has no schedule; it is listed so
 * that each run the worker records shows in the Health tab beside the rest.
 *
 * A "host" kind was handed to a script on the computer itself
 * (deploy/mac/host-jobs/jellyfin-gate-host-jobs.sh), which asked what was due
 * and reported back. The backup was the only one, and now runs in the
 * worker; the runner still works for any kind given it again. A kind's name
 * is all that ever crosses from the database to a command line.
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
  runner: "gate" | "worker" | "loop" | "host";
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

const CRITIC_LIST_SOURCES = [
  { value: "reverseshot", label: "Reverse Shot" },
  { value: "bordwell", label: "David Bordwell" },
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
    kind: "ringer_tv",
    label: "Scrape The Ringer's TV writing",
    description: "Reads the TV articles not yet stored: reviews, recaps and rankings, linked to the shows and episodes in the library.",
    runner: "gate",
    politeByDefault: false,
    run: async () => {
      const { runRingerTvScrape } = await import("./scraping/ringer-tv");
      const r = await runRingerTvScrape(NO_LIMIT);
      return `${r.read} articles read, ${r.lists} lists, ${r.matchedArticles} about a show in the library, ${r.matchedEpisodes} about one episode`;
    },
  },
  {
    kind: "critic_lists",
    label: "Scrape a critics' site's lists",
    description: "Reverse Shot's yearly best-of features, or the yearly ten-best posts on David Bordwell's site, with each film's text. Lists already stored are skipped.",
    runner: "gate",
    politeByDefault: false,
    params: [{ name: "source", label: "Site", options: CRITIC_LIST_SOURCES }],
    title: (p) => `Scrape lists: ${CRITIC_LIST_SOURCES.find((s) => s.value === p.source)?.label ?? p.source}`,
    run: async (p) => {
      if (p.source !== "reverseshot" && p.source !== "bordwell") throw new Error(`Unknown site: ${p.source}`);
      const { runCriticListScrape } = await import("./scraping/critic-lists");
      const r = await runCriticListScrape(p.source);
      return `${r.listsFound} new lists, ${r.entriesFound} films named, ${r.matchedCount} matched to the library`;
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
      const { tmdbRefreshSummary } = await import("./job-summaries");
      return tmdbRefreshSummary(refreshed, added, stills);
    },
  },
  {
    kind: "library_scan",
    label: "Library scan",
    description:
      "Asks Jellyfin to look for added and removed files, then links any list entries waiting on them. Only when the film drive is there: a scan of a missing drive would tell Jellyfin every film was deleted. Jellyfin's own 12-hourly scan is switched off; this replaces it.",
    runner: "gate",
    politeByDefault: true,
    run: async () => {
      const { scanLibraryNow } = await import("./library-scan");
      // A missing drive throws LibraryDriveAbsentError: the run shows as
      // failed, with the reason, and the log says so too.
      const r = await scanLibraryNow();
      return `scan started, ${r.subtitlesPromoted} subtitle files put in place`;
    },
  },
  {
    kind: "folder_match",
    label: "Match files from their folders",
    description:
      "Looks at files nothing has identified and reads the folders they are in: a file in a director's folder is matched against that director's films. Certain matches are applied; the rest wait in the console for a yes or no. Then groups episodes of the same series into their show; groups you made or dissolved are left as they are.",
    runner: "gate",
    politeByDefault: true,
    run: async () => {
      const { runFolderMatch } = await import("./folder-match");
      const r = await runFolderMatch({ apply: true });
      const matched = `${r.looked} unidentified files: ${r.applied} matched, ${r.suggested} to confirm${r.failed ? `, ${r.failed} could not be applied` : ""}`;
      // After the matching, so a file it has just identified as an episode is
      // grouped on the same night (series-autogroup.ts).
      const { describeAutoGroupRun, runSeriesAutoGroup } = await import("./series-autogroup");
      const grouped = await runSeriesAutoGroup()
        .then(describeAutoGroupRun)
        .catch((error) => `episode grouping failed: ${error instanceof Error ? error.message : String(error)}`);
      return `${matched}. Episodes: ${grouped}`;
    },
  },
  {
    kind: "folder_removals",
    label: "Delete folders whose time is up",
    description:
      "Deletes, from the library and the drive, folders marked in the console thirty days ago or more. A folder goes on the run after the one that first finds it due. Taking the mark off in the console before then stops it.",
    runner: "gate",
    politeByDefault: true,
    run: async () => {
      const { runFolderRemovals } = await import("./folder-removals");
      const r = await runFolderRemovals();
      const parts = [
        r.deleted.length ? `deleted ${r.deleted.map((d) => `${d.folder} (${d.files} files)`).join(", ")}` : "nothing deleted",
        r.confirmed.length ? `due, and deleted on the next run: ${r.confirmed.join(", ")}` : "",
        r.refused.length ? `NOT deleted: ${r.refused.map((d) => `${d.folder} (${d.why})`).join(", ")}` : "",
      ];
      return parts.filter(Boolean).join("; ");
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
    description:
      "Copies the database, Jellyfin's settings, .env and the compose file to the backup folder on the drive, reads the copy back, and only then removes the older ones. Run by the worker. A scheduled run skips when the newest backup is under a week old; Run now always takes one.",
    runner: "worker",
    politeByDefault: true,
  },
  {
    kind: "loop_conversions",
    label: "Conversions and download copies",
    description: "Converts queued films a browser cannot play, and prepares offline downloads. Runs in the worker whenever something is queued.",
    runner: "loop",
    politeByDefault: false,
  },
  {
    kind: "loop_upload_scan",
    label: "Upload virus scan",
    description: "Scans uploads waiting in quarantine with ClamAV. Runs in the worker whenever an upload is waiting and nobody is watching.",
    runner: "loop",
    politeByDefault: false,
  },
  {
    kind: "loop_file_check",
    label: "Damaged-file check",
    description: "Reads library files through for damage, a few minutes at a time, when nothing is queued and nobody is watching.",
    runner: "loop",
    politeByDefault: false,
  },
  {
    kind: "loop_browser_audio",
    label: "Browser audio",
    description:
      "Adds a stereo AAC track to films whose only sound a browser can't play (DTS, TrueHD...), so they play straight off the drive instead of having their audio re-encoded live. Keeps every original track. Up to 20 a day, when nothing is queued and nobody is watching; \"Add browser audio now\" on a film does one at once.",
    runner: "loop",
    politeByDefault: false,
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
 * it. Listed so the Jobs card accounts for everything that runs, including
 * the little that still runs on the Mac itself rather than in the stack.
 * The worker's continuous work is not here: it records its runs, so it is
 * in the job list (the "loop" kinds above).
 */
export const ALWAYS_ON: Array<{ label: string; every: string; where: string }> = [
  { label: "New film, show and episode notifications", every: "10 minutes", where: "the site" },
  { label: "Starting scheduled watch parties", every: "1 minute", where: "the site" },
  { label: "Ending watch parties nobody has been in for 15 minutes", every: "1 minute", where: "the site" },
  { label: "Revealing scheduled episodes", every: "10 minutes", where: "the site" },
  { label: "Removing expired screenings", every: "1 hour", where: "the site" },
  { label: "Refreshing the list of known films", every: "a few hours", where: "the site" },
  { label: "Starting the site once the film drive is mounted, stopping it if the drive goes", every: "2 minutes", where: "the Mac (com.watch.up)" },
  { label: "Off-hours shutdown and start-up", every: "as set in Watch Control", where: "the Mac" },
];
