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

  void startOmdbBackfillLoop();
  void startWikipediaBackfillLoop();
  void startLibraryNotifyLoop();
}

declare global {
  // eslint-disable-next-line no-var
  var __jellyfinGateOmdbBackfillTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __jellyfinGateWikipediaBackfillTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __jellyfinGateLibraryNotifyTimer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Keeps OMDb ratings coverage catching up in small, budget-respecting
 * batches for as long as the process runs — see src/lib/omdb-backfill.ts for
 * why this exists instead of any kind of "refresh everything now" pass. A
 * global-pinned timer, same reasoning as the rate limiter's bucket map: dev
 * mode re-runs register() on every hot reload, and without pinning this
 * would start a second (and third, and fourth...) overlapping interval.
 */
async function startOmdbBackfillLoop(): Promise<void> {
  if (globalThis.__jellyfinGateOmdbBackfillTimer) return;

  try {
    const { TICK_INTERVAL_MS, runOmdbBackfillTick } = await import("./lib/omdb-backfill");
    globalThis.__jellyfinGateOmdbBackfillTimer = setInterval(() => {
      void runOmdbBackfillTick().catch((error) => console.error("[boot] omdb backfill tick failed:", error));
    }, TICK_INTERVAL_MS);
    console.log("[boot] omdb backfill loop started");
  } catch (error) {
    console.error("[boot] omdb backfill loop failed to start (ratings will still refresh on-demand):", error);
  }
}

/**
 * Same shape as startOmdbBackfillLoop, for src/lib/wikipedia-backfill.ts —
 * works through the library's Wikipedia coverage a few films at a time for
 * as long as the process runs, instead of leaving it at "one film at a
 * time, whenever a curator happens to click the button."
 */
async function startWikipediaBackfillLoop(): Promise<void> {
  if (globalThis.__jellyfinGateWikipediaBackfillTimer) return;

  try {
    const { TICK_INTERVAL_MS, runWikipediaBackfillTick } = await import("./lib/wikipedia-backfill");
    globalThis.__jellyfinGateWikipediaBackfillTimer = setInterval(() => {
      void runWikipediaBackfillTick().catch((error) => console.error("[boot] wikipedia backfill tick failed:", error));
    }, TICK_INTERVAL_MS);
    console.log("[boot] wikipedia backfill loop started");
  } catch (error) {
    console.error("[boot] wikipedia backfill loop failed to start (Wikipedia data will still be fetchable on-demand):", error);
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
