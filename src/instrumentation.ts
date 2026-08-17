/**
 * Runs once when the server process starts, before it serves anything.
 *
 * The database connection is otherwise opened lazily, on the first request that
 * happens to touch it. That is fine on a machine where the file already exists,
 * and wrong on a fresh deployment: the schema does not exist until somebody
 * makes exactly the right request, and anything else reading the database in
 * the meantime — notably the watch-folder worker, which is a separate container
 * with no ordering guarantee — finds an empty file and fails.
 *
 * Creating it here makes "the schema exists once the gateway is up" true rather
 * than approximately true.
 */
export async function register(): Promise<void> {
  // Only the Node.js runtime can open SQLite; the Edge runtime also evaluates
  // this file.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getDb } = await import("./lib/db");
  getDb();
  console.log("[boot] database ready");

  // Fire-and-forget: a fresh container may start before Jellyfin itself has
  // finished coming up, and a scan failing here must never take the gate
  // down with it — it's a courtesy the next manual scan or restart can
  // always redo. Not awaited, so this never delays "the gateway is up".
  void runStartupScan();

  // Same reasoning as above, for Browse's director/actor cast cache: fetching
  // it costs Jellyfin ~20 seconds regardless of who asks or when, so asking
  // at boot means that cost lands during startup instead of on whoever loads
  // Browse first — without this, that's exactly what happens after every
  // restart once the previous warm-up's 12-hour cache entry has lapsed.
  void warmBrowseCache();

  void startAutoScrapeLoop();
  void startLibraryNotifyLoop();
  void startKnownFilmsRefreshLoop();
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateAutoScrapeTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __jellyfinGateLibraryNotifyTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __jellyfinGateKnownFilmsTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * The OMDb/Wikipedia catch-up loops used to fire unconditionally every 10
 * minutes for as long as the process ran. They now only do real work on a
 * curator's "Scrape now" click (src/app/api/admin/scrape/run-now/route.ts)
 * or once a week, Wednesday 5:30am — see src/lib/scrape-schedule.ts. This
 * loop just checks the clock every 10 minutes and calls through when the
 * window is open; the check itself is nearly free.
 */
async function startAutoScrapeLoop(): Promise<void> {
  if (globalThis.__jellyfinGateAutoScrapeTimer) return;

  try {
    const { runAutoScrapePassIfScheduled } = await import("./lib/scrape-schedule");
    globalThis.__jellyfinGateAutoScrapeTimer = setInterval(() => {
      void runAutoScrapePassIfScheduled()
        .then((result) => {
          if (result) console.log("[boot] weekly auto-scrape pass finished:", result);
        })
        .catch((error) => console.error("[boot] weekly auto-scrape pass failed:", error));
    }, 10 * 60 * 1000);
    console.log("[boot] auto-scrape schedule loop started (Wednesday 5:30am, or manual trigger)");
  } catch (error) {
    console.error("[boot] auto-scrape schedule loop failed to start (still runnable manually via the console):", error);
  }
}

/**
 * Same shape as startOmdbBackfillLoop, for src/lib/library-notify.ts — checks
 * for newly added movies and notifies every user in-app, a few minutes at a
 * time for as long as the process runs.
 */
async function startLibraryNotifyLoop(): Promise<void> {
  if (globalThis.__jellyfinGateLibraryNotifyTimer) return;

  try {
    const { TICK_INTERVAL_MS, runLibraryNotifyTick } = await import("./lib/library-notify");
    globalThis.__jellyfinGateLibraryNotifyTimer = setInterval(() => {
      void runLibraryNotifyTick().catch((error) => console.error("[boot] library notify tick failed:", error));
    }, TICK_INTERVAL_MS);
    console.log("[boot] library notify loop started");
  } catch (error) {
    console.error("[boot] library notify loop failed to start (new-item notifications will not fire):", error);
  }
}

/**
 * Proactively refreshes src/lib/known-films.ts's shared cache on its own
 * schedule (see REFRESH_INTERVAL_MS there for why it's shorter than the
 * cache's own TTL) instead of leaving it to whichever of the three backfill
 * loops happens to hit a stale cache first — that reactive path pays the
 * ~90-second admin pull synchronously inside a 10-minute tick, in the same
 * process serving real requests. An initial fire-and-forget call warms it at
 * boot too, same reasoning as warmBrowseCache() below.
 */
async function startKnownFilmsRefreshLoop(): Promise<void> {
  if (globalThis.__jellyfinGateKnownFilmsTimer) return;

  try {
    const { REFRESH_INTERVAL_MS, refreshKnownFilmsNow } = await import("./lib/known-films");
    void refreshKnownFilmsNow().catch((error) => console.error("[boot] known films warm-up failed (will refresh on-demand):", error));
    globalThis.__jellyfinGateKnownFilmsTimer = setInterval(() => {
      void refreshKnownFilmsNow().catch((error) => console.error("[boot] known films refresh failed:", error));
    }, REFRESH_INTERVAL_MS);
    console.log("[boot] known films refresh loop started");
  } catch (error) {
    console.error("[boot] known films refresh loop failed to start (will still refresh reactively on-demand):", error);
  }
}

async function warmBrowseCache(): Promise<void> {
  try {
    const { warmBrowsePeopleCache } = await import("./lib/browse-data");
    await warmBrowsePeopleCache();
    console.log("[boot] browse cast cache warm");
  } catch (error) {
    console.error("[boot] browse cast cache warm-up failed (Browse will fetch it on first request instead):", error);
  }
}

async function runStartupScan(): Promise<void> {
  try {
    const { promoteSubtitles } = await import("./lib/subtitle-promotion");
    const subtitles = await promoteSubtitles();
    if (subtitles.failed.length > 0) {
      console.error("[boot] subtitle promotion failures:", subtitles.failed);
    }
    if (subtitles.promoted.length > 0) {
      console.log(`[boot] promoted ${subtitles.promoted.length} subtitle file(s)`);
    }

    const { refreshLibrary } = await import("./lib/jellyfin");
    await refreshLibrary();
    console.log("[boot] startup library scan triggered");
  } catch (error) {
    console.error("[boot] startup library scan failed (will retry on next manual scan):", error);
  }
}
