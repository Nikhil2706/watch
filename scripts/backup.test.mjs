import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BACKUP_MARKER, backupStamp, datedFolders, execQuiet, runBackup, snapshotDatabase } from "./backup.mjs";

const NOW = Date.parse("2026-10-14T18:30:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A backup drive with dated backups already on it, and the stack's files to copy. */
function setup({ older = ["2026-09-30", "2026-10-06"], ageDays = 8, marker = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "backup-test-"));
  const root = join(base, "jellyfin-gate-backups");
  mkdirSync(root);
  if (marker) writeFileSync(join(root, BACKUP_MARKER), "");
  for (const name of older) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, "MANIFEST.txt"), "old");
    const t = (NOW - ageDays * DAY) / 1000;
    utimesSync(join(root, name, "MANIFEST.txt"), t, t);
  }
  writeFileSync(join(root, "notes.txt"), "the owner's own file");
  mkdirSync(join(root, "keep-me"));
  const stack = join(base, "stack");
  mkdirSync(stack);
  writeFileSync(join(stack, ".env"), "ADMIN_API_KEY=secret\n");
  writeFileSync(join(stack, "docker-compose.yml"), "services: {}\n");
  const config = join(base, "jellyfin-config");
  mkdirSync(join(config, "data"), { recursive: true });
  writeFileSync(join(config, "data", "library.db"), "jellyfin");
  return { base, root, stack, config };
}

/**
 * A stand-in for tar and gzip that writes what tar would and records every
 * call, with the dated folders on the drive at that moment.
 */
function fakeExec(root, { unreadable = false } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push({ command, args, folders: datedFolders(root) });
    if (command === "tar" && args[0] === "czf") {
      writeFileSync(args[1], "tarball");
      return { code: 0, stderr: "" };
    }
    if (command === "gzip" && args[0] === "-t") return { code: unreadable ? 1 : 0, stderr: unreadable ? "unexpected end of file" : "" };
    if (command === "tar" && args[0] === "-tzf") return { code: 0, stderr: "" };
    throw new Error(`unexpected ${command} ${args.join(" ")}`);
  };
  return { exec, calls };
}

const fakeSnapshot = async (destGz) => {
  writeFileSync(destGz, "db");
  return 58;
};

function options(env, extra = {}) {
  return {
    root: env.root,
    stamp: backupStamp(NOW),
    forced: false,
    now: NOW,
    snapshot: fakeSnapshot,
    jellyfinConfig: env.config,
    stackDir: env.stack,
    ...extra,
  };
}

test("the stamp is the IST date", () => {
  assert.equal(backupStamp(Date.parse("2026-10-14T18:30:00Z")), "2026-10-15");
  assert.equal(backupStamp(Date.parse("2026-10-14T18:29:00Z")), "2026-10-14");
});

test("reads the new backup back before removing any older one, then keeps only the newest", async () => {
  const env = setup();
  const fake = fakeExec(env.root);
  const line = await runBackup(options(env, { exec: fake.exec }));
  assert.equal(line, "Backup taken and read back. 2 older one(s) removed.");

  // The read-back (gzip -t, tar -t) ran while both older backups were still there.
  const verify = fake.calls.filter((c) => (c.command === "gzip" && c.args[0] === "-t") || (c.command === "tar" && c.args[0] === "-tzf"));
  assert.equal(verify.length, 2);
  for (const c of verify) assert.deepEqual(c.folders, ["2026-09-30", "2026-10-06"]);

  assert.deepEqual(datedFolders(env.root), ["2026-10-15"]);
  // Only dated folders are ever removed.
  assert.ok(existsSync(join(env.root, "notes.txt")));
  assert.ok(existsSync(join(env.root, "keep-me")));
  assert.ok(existsSync(join(env.root, BACKUP_MARKER)));
  // No half-written folder left behind.
  assert.deepEqual(readdirSync(env.root).filter((n) => n.includes("partial")), []);

  const dest = join(env.root, "2026-10-15");
  assert.deepEqual(readdirSync(dest).sort(), ["MANIFEST.txt", "docker-compose.yml", "env.backup", "gate-data.db.gz", "jellyfin-config.tar.gz"]);
  assert.equal(readFileSync(join(dest, "env.backup"), "utf8"), "ADMIN_API_KEY=secret\n");
  const manifest = readFileSync(join(dest, "MANIFEST.txt"), "utf8");
  assert.match(manifest, /schema version: 58/);
  assert.match(manifest, /gate-data\.db\.gz/);
});

test("a backup that cannot be read back keeps every older one", async () => {
  const env = setup();
  const fake = fakeExec(env.root, { unreadable: true });
  await assert.rejects(runBackup(options(env, { exec: fake.exec })), {
    message: "Backup taken, but it could not be read back, so the older ones are kept.",
  });
  assert.deepEqual(datedFolders(env.root), ["2026-09-30", "2026-10-06"]);
});

test("a step that fails stops the backup before anything is removed", async () => {
  const env = setup();
  const fake = fakeExec(env.root);
  const snapshot = async () => {
    throw new Error("database is locked");
  };
  await assert.rejects(runBackup(options(env, { exec: fake.exec, snapshot })), /BACKUP FAILED \(the site's database\): database is locked/);
  assert.deepEqual(datedFolders(env.root), ["2026-09-30", "2026-10-06"]);
  assert.deepEqual(readdirSync(env.root).filter((n) => n.includes("partial")), []);
  assert.equal(fake.calls.length, 0);
});

test("a scheduled run is not due while the newest backup is under a week old; Run now takes one anyway", async () => {
  const env = setup({ ageDays: 3 });
  const fake = fakeExec(env.root);
  assert.equal(await runBackup(options(env, { exec: fake.exec })), "Not due: the newest backup is 3 day(s) old.");
  assert.equal(fake.calls.length, 0);
  assert.equal(await runBackup(options(env, { exec: fake.exec, forced: true })), "Backup taken and read back. 2 older one(s) removed.");
});

test("a folder with no earlier backup and no marker is not trusted to be the drive", async () => {
  const env = setup({ older: [], marker: false });
  const fake = fakeExec(env.root);
  await assert.rejects(runBackup(options(env, { exec: fake.exec, forced: true })), /may not be the drive/);
  assert.deepEqual(readdirSync(env.root).sort(), ["keep-me", "notes.txt"]);
});

test("earlier backups are proof enough, and the marker is left for next time", async () => {
  const env = setup({ marker: false });
  const fake = fakeExec(env.root);
  await runBackup(options(env, { exec: fake.exec }));
  assert.ok(existsSync(join(env.root, BACKUP_MARKER)));
});

test("a missing backup folder (drive not connected) writes nothing", async () => {
  const env = setup();
  await assert.rejects(runBackup(options(env, { root: join(env.base, "not-there") })), /not there.*Nothing was written/);
  assert.equal(existsSync(join(env.base, "not-there")), false);
});

test("the real thing: snapshot, tar and gzip, read back", async () => {
  const env = setup();
  const dbPath = join(env.base, "gate.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA user_version = 58; CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('kept')");
  const line = await runBackup(
    options(env, {
      exec: execQuiet,
      snapshot: (destGz) => snapshotDatabase({ db, DatabaseSync, snapshotPath: join(env.base, ".backup-snapshot.db"), destGz }),
    }),
  );
  db.close();
  assert.equal(line, "Backup taken and read back. 2 older one(s) removed.");
  assert.equal(existsSync(join(env.base, ".backup-snapshot.db")), false);
  const { gunzipSync } = await import("node:zlib");
  const restored = join(env.base, "restored.db");
  writeFileSync(restored, gunzipSync(readFileSync(join(env.root, "2026-10-15", "gate-data.db.gz"))));
  const back = new DatabaseSync(restored, { readOnly: true });
  assert.equal(back.prepare("SELECT x FROM t").get().x, "kept");
  back.close();
});
