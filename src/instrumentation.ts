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
}
