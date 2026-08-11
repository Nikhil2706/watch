/**
 * Standalone database initialiser.
 *
 *   npm run db:init
 *
 * The app also creates the schema on boot (see src/lib/db.ts), so this script is
 * not required in normal operation. It exists for two cases: checking the
 * database is writable before installing the Windows service, and inspecting
 * what the schema will be without starting Next.
 *
 * Run directly by Node via --experimental-strip-types, so it deliberately does
 * not import src/lib/db.ts — that module pulls in env.ts, which refuses to load
 * without a full production environment. The one thing worth sharing, the
 * schema itself, is imported so there is no second copy to drift.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/lib/schema.ts";

/** Minimal .env reader. Next loads these itself; a bare node script does not. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const configured = process.env.DATABASE_PATH?.trim() || "./data/jellyfin-gate.db";
const dbPath = isAbsolute(configured) ? configured : resolve(process.cwd(), configured);

mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");

const row = db.prepare("PRAGMA user_version").get() as
  | { user_version: number }
  | undefined;
const current = row?.user_version ?? 0;

if (current >= SCHEMA_VERSION) {
  console.log(`Database already at schema v${current}: ${dbPath}`);
} else {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
    console.log(`Initialised schema v${SCHEMA_VERSION} at ${dbPath}`);
  } catch (error) {
    db.exec("ROLLBACK");
    console.error("Schema initialisation failed:", error);
    process.exitCode = 1;
  }
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all() as Array<{ name: string }>;
console.log("Tables:", tables.map((t) => t.name).join(", "));

db.close();
