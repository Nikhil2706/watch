/**
 * The backup, run by the worker (scripts/worker-jobs.mjs) when the site's
 * "Backup" job comes due. It replaces deploy/mac/host-jobs/backup-to-e.sh and
 * jellyfin-gate-backup.sh, which a launchd agent on the Mac ran every minute
 * and which had to do every read and write on the drive through `docker run`,
 * because macOS does not let a launchd job touch an external drive. The
 * worker container has the drive mounted, so none of that is needed.
 *
 * What it captures, and why:
 *
 *   gate-data.db.gz        the site's database (sessions, curation, invites,
 *                          the TMDB cache: everything), snapshotted with
 *                          VACUUM INTO. A plain copy of a live SQLite file can
 *                          be torn mid-write and restore to a corrupt
 *                          database; VACUUM INTO is a consistent snapshot.
 *   jellyfin-config.tar.gz Jellyfin's library database and settings. Losing
 *                          it means a full rescan and new item ids.
 *   env.backup             the secrets (.env), which are not in git.
 *   docker-compose*.yml    so the stack can be stood up again as it was.
 *   MANIFEST.txt           what this is, and how to restore it.
 *
 * Films are not backed up: they are on the drive already, and replaceable.
 *
 * The owner keeps only the newest backup (2026-10-13: each is about 2 GB).
 * Older dated folders are removed only after the new one has been read back
 * from the drive (gzip -t, tar -t): a backup that cannot be read is no reason
 * to delete the one before it.
 */

import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** A scheduled run takes a backup only once the newest is this old; "Run now" always does. */
export const BACKUP_MAX_AGE_DAYS = 7;
/**
 * Left in the backup folder. Without it, or an earlier backup, the folder is
 * not trusted to be the drive: Docker creates a missing bind-mount folder on
 * the Mac's own disk, and a backup landing there is the failure this job
 * exists to prevent.
 */
export const BACKUP_MARKER = ".watch-backups";

const DATED = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The dated backup folders in the root, oldest first. Nothing else there is ever touched. */
export function datedFolders(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATED.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** "2026-10-14", in the curator's time zone (IST, no daylight saving). */
export function backupStamp(nowMs) {
  return new Date(nowMs + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10);
}

/** Runs a command; stdout is thrown away (tar -t lists every file). */
export function execQuiet(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      if (stderr.length < 20_000) stderr += d;
    });
    child.on("error", (err) => resolve({ code: -1, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/**
 * Writes a gzipped VACUUM INTO snapshot of the open database `db` to
 * `destGz`, after checking the snapshot opens and passes quick_check.
 * Returns the snapshot's schema version, for the manifest.
 */
export async function snapshotDatabase({ db, DatabaseSync, snapshotPath, destGz }) {
  rmSync(snapshotPath, { force: true });
  try {
    db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(snapshotPath, { readOnly: true });
    let version;
    try {
      const check = copy.prepare("PRAGMA quick_check").get();
      if (check?.quick_check !== "ok") throw new Error(`the snapshot failed its integrity check: ${check?.quick_check}`);
      version = Number(copy.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    } finally {
      copy.close();
    }
    await pipeline(createReadStream(snapshotPath), createGzip(), createWriteStream(destGz));
    return version;
  } finally {
    rmSync(snapshotPath, { force: true });
  }
}

function sizeOf(path) {
  const bytes = statSync(path).size;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}G`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}M`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)}K`;
  return `${bytes}B`;
}

/**
 * Takes a backup into `<root>/<stamp>/`. Returns the line the console shows;
 * throws when the backup could not be taken or read back (the run is then
 * recorded as failed, and the older backups are kept).
 *
 *   root        the backup folder (BACKUP_PATH, mounted at /backups)
 *   stamp       the dated folder's name
 *   forced      "Run now": take one however recent the newest is
 *   snapshot    async (destGz) => schema version; writes the database
 *   jellyfinConfig  Jellyfin's /config, mounted read-only
 *   stackDir    where .env and the compose files are mounted read-only
 *   exec        (command, args) => Promise<{ code, stderr }>
 */
export async function runBackup({ root, stamp, forced, now = Date.now(), snapshot, jellyfinConfig, stackDir, exec = execQuiet, log = () => {} }) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`The backup folder is not there (${root}). Is the drive connected? Nothing was written.`);
  }
  const before = datedFolders(root);
  if (!existsSync(join(root, BACKUP_MARKER))) {
    if (before.length === 0) {
      throw new Error(
        `The backup folder (${root}) holds no earlier backup and no ${BACKUP_MARKER} file, so it may not be the drive (BACKUP_PATH unset, or the drive missing when the stack started). Create ${BACKUP_MARKER} in the drive's backup folder to start. Nothing was written.`,
      );
    }
    writeFileSync(join(root, BACKUP_MARKER), "The site's backups (scripts/backup.mjs). Only the dated folders here are ever removed.\n");
  }

  // --- is one due? ----------------------------------------------------------
  const newest = [...before].reverse().find((name) => existsSync(join(root, name, "MANIFEST.txt")));
  if (newest && !forced) {
    const age = Math.floor((now - statSync(join(root, newest, "MANIFEST.txt")).mtimeMs) / DAY_MS);
    if (age < BACKUP_MAX_AGE_DAYS) return `Not due: the newest backup is ${age} day(s) old.`;
    log(`backup: the newest (${newest}) is ${age} days old, taking one`);
  }

  // Written beside the others under a name no rule here treats as a backup,
  // and given its dated name only once it has been read back: a failed run
  // never leaves a half-written folder that looks like the newest backup, or
  // replaces a good one taken earlier the same day.
  const dest = join(root, stamp);
  const work = join(root, `.${stamp}.partial`);
  const step = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      rmSync(work, { recursive: true, force: true });
      throw new Error(`BACKUP FAILED (${what}): ${error instanceof Error ? error.message : String(error)}. The older backups are kept.`);
    }
  };

  log(`backup: writing ${dest}`);
  await step("making the folder", () => {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
  });

  // --- 1. the database ------------------------------------------------------
  const version = await step("the site's database", () => snapshot(join(work, "gate-data.db.gz")));

  // --- 2. Jellyfin's config -------------------------------------------------
  await step("Jellyfin's settings", async () => {
    if (!existsSync(jellyfinConfig)) throw new Error(`${jellyfinConfig} is not mounted`);
    const r = await exec("tar", ["czf", join(work, "jellyfin-config.tar.gz"), "-C", jellyfinConfig, "."]);
    if (r.code !== 0) throw new Error(`tar exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
  });

  // --- 3. the files that are not in git --------------------------------------
  // env.backup holds every secret the stack has. exFAT keeps no permissions,
  // so what protects it is who can reach the drive.
  await step(".env and the compose files", () => {
    copyFileSync(join(stackDir, ".env"), join(work, "env.backup"));
    copyFileSync(join(stackDir, "docker-compose.yml"), join(work, "docker-compose.yml"));
    const override = join(stackDir, "docker-compose.override.yml");
    if (existsSync(override) && statSync(override).isFile()) copyFileSync(override, join(work, "docker-compose.override.yml"));
  });

  // --- 4. a manifest, so a restorer knows what they are looking at ----------
  await step("the manifest", () => {
    const files = readdirSync(work).sort();
    writeFileSync(
      join(work, "MANIFEST.txt"),
      [
        "jellyfin-gate backup",
        `taken:          ${new Date(now).toISOString()}`,
        `by:             the worker container (${hostname()})`,
        `schema version: ${version ?? "unknown"}`,
        "",
        "contents:",
        ...files.map((f) => `  ${sizeOf(join(work, f))}\t${f}`),
        "",
        "restore: gunzip gate-data.db.gz and put it at /app/data/jellyfin-gate.db",
        "         in the gate-data volume; untar jellyfin-config.tar.gz into the",
        "         jellyfin-config volume; copy env.backup back to .env.",
        "",
      ].join("\n"),
    );
  });

  // --- 5. read it back, and only then remove the older ones ------------------
  const readable =
    existsSync(join(work, "MANIFEST.txt")) &&
    existsSync(join(work, "env.backup")) &&
    (await exec("gzip", ["-t", join(work, "gate-data.db.gz")])).code === 0 &&
    (await exec("tar", ["-tzf", join(work, "jellyfin-config.tar.gz")])).code === 0;
  if (!readable) {
    // Left as it is for a look (the next run clears it); never given a date.
    throw new Error("Backup taken, but it could not be read back, so the older ones are kept.");
  }
  await step("naming the folder", () => {
    rmSync(dest, { recursive: true, force: true });
    renameSync(work, dest);
  });

  let removed = 0;
  for (const name of datedFolders(root)) {
    if (name === stamp) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    log(`backup: removed older backup ${name}`);
    removed += 1;
  }
  return `Backup taken and read back. ${removed} older one(s) removed.`;
}

