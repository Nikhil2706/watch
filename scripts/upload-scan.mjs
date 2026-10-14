/**
 * Virus scan of Langlois-mode uploads, run by the worker (media-worker.mjs).
 *
 * An upload lands in MEDIA_QUARANTINE with status 'uploaded' and can only be
 * approved once it is 'clean' (uploads.ts). Nothing used to make it clean:
 * the scan was a Windows Defender task that was never set up. This is that
 * scan, inside the stack, with ClamAV:
 *
 *   uploaded --(scan starts)--> scanning --> clean     (curator may approve)
 *                                         \-> infected (never approvable; the
 *                                              file stays in quarantine until
 *                                              the curator rejects it, and an
 *                                              error goes in the activity log)
 *                                         \-> uploaded + scan_result "Scan
 *                                              failed: ..." and scanned_at =
 *                                              the attempt; retried an hour on
 *                                              (a ClamAV error, a missing file,
 *                                              no signatures)
 *
 * `uploads.scan_result` and `scanned_at` are the fields the console's Uploads
 * tab and the health check already read. A row found 'scanning' was cut off
 * (the worker restarted, or clamscan was killed for memory): it becomes a
 * failed attempt, not an immediate retry, so a file that runs the container
 * out of memory is not retried every minute.
 *
 * Never while someone is streaming (the worker's PAUSE_WHILE_STREAMING check
 * is passed in as isBusy) — clamscan is heavy on memory and disk.
 *
 * The state handling is pure over a DatabaseSync handle and injected scanner,
 * so upload-scan.test.mjs runs it with the scanner mocked. The ClamAV runner
 * itself is clamavScanner() at the bottom.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** A failed scan is tried again after this long. */
export const SCAN_RETRY_MS = 60 * 60 * 1000;
/** The quarantine's heartbeat file; uploads.ts reads it for the health check. */
export const HEARTBEAT_FILE = ".scanner-heartbeat.json";

const PENDING = "('uploaded', 'scanning')";

export function uploadsTableReady(db) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='uploads'").get());
}

/** Uploads to scan now: never tried, or the last attempt failed long enough ago. Oldest first. */
export function eligibleUploads(db, now) {
  return db
    .prepare(
      `SELECT id, filename, quarantine_path, size_bytes, status, scan_result, scanned_at FROM uploads
        WHERE status = 'uploaded' AND (scanned_at IS NULL OR scanned_at <= ?)
        ORDER BY created_at`,
    )
    .all(now - SCAN_RETRY_MS);
}

function waitingCount(db) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM uploads WHERE status IN ${PENDING}`).get()?.n ?? 0);
}

/** Only rows still waiting are changed: a curator who rejected it mid-scan wins. */
function setResult(db, id, status, detail, at) {
  db.prepare(`UPDATE uploads SET status = ?, scan_result = ?, scanned_at = ? WHERE id = ? AND status IN ${PENDING}`).run(
    status,
    detail,
    at,
    id,
  );
}

/** A 'scanning' row at the start of a pass was cut off; count it as a failed attempt. */
export function recoverInterrupted(db, now) {
  const rows = db.prepare("SELECT id FROM uploads WHERE status = 'scanning'").all();
  for (const r of rows) {
    db.prepare("UPDATE uploads SET status = 'uploaded', scan_result = ?, scanned_at = COALESCE(scanned_at, ?) WHERE id = ?").run(
      "Scan failed: it stopped part-way (the worker restarted, or ClamAV ran out of memory). Trying again later.",
      now,
      r.id,
    );
  }
  return rows.length;
}

/**
 * One pass: scans every eligible upload, unless someone is watching.
 *
 * deps:
 *   scanner        { available(): boolean, ensureSignatures(): Promise<{ ok, detail, signaturesAt }>,
 *                    scan(path, sizeBytes): Promise<{ verdict: 'clean'|'infected'|'error', detail }> }
 *   isBusy         async () => boolean   (someone is streaming)
 *   heartbeat      (info) => void        (writes the quarantine heartbeat)
 *   logEvent       ({ severity, message, detail }) => void
 *   fileExists     (path) => boolean
 *   now            () => number
 *   log            (...args) => void
 */
export async function scanWaitingUploads(db, deps) {
  const { scanner, isBusy, heartbeat, logEvent, fileExists, now, log } = deps;
  const result = { scanned: 0, clean: 0, infected: 0, failed: 0, deferred: false, recovered: 0 };
  if (!uploadsTableReady(db) || !scanner.available()) return result;

  result.recovered = recoverInterrupted(db, now());
  const todo = eligibleUploads(db, now());
  if (todo.length === 0) {
    heartbeat({ waiting: waitingCount(db) });
    return result;
  }
  if (await isBusy()) {
    result.deferred = true;
    heartbeat({ waiting: waitingCount(db), deferred: "someone is watching" });
    return result;
  }

  const sigs = await scanner.ensureSignatures();
  if (!sigs.ok) {
    // No heartbeat: with nothing to scan against, the scanner is not working,
    // and the health check should say so once uploads have waited a while.
    for (const u of todo) setResult(db, u.id, "uploaded", `Scan failed: ${sigs.detail}`, now());
    logEvent({ severity: "warning", message: `Upload scan can't run: ${sigs.detail}`, detail: { waiting: todo.length } });
    return result;
  }

  for (const u of todo) {
    if (await isBusy()) {
      result.deferred = true;
      log("upload scan: someone is watching — stopping for now");
      break;
    }
    if (!fileExists(u.quarantine_path)) {
      setResult(db, u.id, "uploaded", "Scan failed: the file is missing from quarantine.", now());
      result.failed += 1;
      continue;
    }
    setResult(db, u.id, "scanning", null, now());
    heartbeat({ waiting: waitingCount(db), scanning: u.filename, signaturesAt: sigs.signaturesAt });
    let out;
    try {
      out = await scanner.scan(u.quarantine_path, u.size_bytes);
    } catch (error) {
      out = { verdict: "error", detail: error instanceof Error ? error.message : String(error) };
    }
    result.scanned += 1;
    if (out.verdict === "clean") {
      setResult(db, u.id, "clean", out.detail, now());
      result.clean += 1;
      log(`upload scan: clean ${u.filename}`);
    } else if (out.verdict === "infected") {
      // Kept out of the library: approveUpload refuses anything not 'clean'.
      // The file stays where it is; only the curator's Reject deletes it.
      setResult(db, u.id, "infected", out.detail, now());
      result.infected += 1;
      log(`upload scan: INFECTED ${u.filename} (${out.detail})`);
      logEvent({
        severity: "error",
        message: `Upload "${u.filename}" failed the virus scan (${out.detail}). It can't be approved; it stays in quarantine until you reject it in the console's Uploads tab.`,
        detail: { uploadId: u.id, file: u.quarantine_path, threat: out.detail },
      });
    } else {
      setResult(db, u.id, "uploaded", `Scan failed: ${out.detail}`, now());
      result.failed += 1;
      log(`upload scan: failed ${u.filename} (${out.detail})`);
      logEvent({
        severity: "warning",
        message: `Upload "${u.filename}" couldn't be scanned: ${out.detail}. Trying again in an hour.`,
        detail: { uploadId: u.id, file: u.quarantine_path },
      });
    }
  }
  heartbeat({ waiting: waitingCount(db), signaturesAt: sigs.signaturesAt });
  return result;
}

/* ------------------------------------------------------------------ *
 * ClamAV
 * ------------------------------------------------------------------ */

/**
 * clamscan's answer. Exit 0 = nothing found, 1 = found ("<path>: <name> FOUND"
 * per hit), 2 = an error. Killed by a signal is almost always the container's
 * memory limit: the signature database alone is over a gigabyte in memory.
 */
export function parseClamscan({ code, signal, stdout, stderr, timedOut, timeoutMs }) {
  if (timedOut) return { verdict: "error", detail: `ClamAV took longer than ${Math.round(timeoutMs / 60000)} minutes` };
  if (signal || code === 137) {
    return { verdict: "error", detail: `ClamAV was killed (${signal ?? "exit 137"}) — most likely the worker's memory limit` };
  }
  if (code === 0) return { verdict: "clean", detail: "" };
  if (code === 1) {
    const found = [...String(stdout).matchAll(/: (.+) FOUND$/gm)].map((m) => m[1]);
    return { verdict: "infected", detail: found.length ? [...new Set(found)].join(", ") : "ClamAV reported a threat" };
  }
  const why = String(stderr).trim().split("\n").filter(Boolean).pop() ?? `exit ${code}`;
  return { verdict: "error", detail: `ClamAV error: ${why.slice(0, 300)}` };
}

/** When the signatures in `dir` were last updated (newest daily/main/bytecode file), or null when there are none. */
export function signaturesAt(dir) {
  try {
    const files = readdirSync(dir).filter((f) => /^(main|daily|bytecode)\.(cvd|cld)$/.test(f));
    if (!files.some((f) => f.startsWith("main.")) || !files.some((f) => f.startsWith("daily."))) return null;
    return Math.max(...files.map((f) => statSync(join(dir, f)).mtimeMs));
  } catch {
    return null;
  }
}

function runCapture(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    // nice: a scan is the least urgent thing on the box.
    const child = spawn("nice", ["-n", "15", command, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < 1_000_000) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 1_000_000) stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveRun({ code: 2, signal: null, stdout, stderr: String(err), timedOut, timeoutMs });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A timeout's SIGKILL is reported as the timeout, not as memory.
      resolveRun({ code, signal: timedOut ? null : signal, stdout, stderr, timedOut, timeoutMs });
    });
  });
}

function onPath(command) {
  return (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, command)));
}

/**
 * The real scanner: clamscan on demand, not a resident clamd. Uploads are
 * rare, and clamd would hold the whole signature database in memory (1+ GB)
 * all day to scan a file a week; clamscan loads it for the scan and gives it
 * back. Signatures live in a volume and are fetched by freshclam just before
 * a scan when they are a day old (the first time: ~300 MB).
 */
export function clamavScanner({
  dbDir = "/var/lib/clamav",
  clamscan = "clamscan",
  freshclam = "freshclam",
  maxMb = 4000,
  scanTimeoutMs = 2 * 60 * 60 * 1000,
  updateTimeoutMs = 30 * 60 * 1000,
  maxAgeMs = 24 * 60 * 60 * 1000,
  log = () => {},
} = {}) {
  const stamp = join(dbDir, ".last-update-attempt");
  const lastAttempt = () => {
    try {
      return Number(readFileSync(stamp, "utf8")) || 0;
    } catch {
      return 0;
    }
  };
  return {
    available: () => onPath(clamscan),
    async ensureSignatures() {
      const have = signaturesAt(dbDir);
      const since = Date.now() - lastAttempt();
      // Fresh enough, or tried recently (ClamAV's mirrors block clients that ask too often).
      const due = have === null ? since > 60 * 60 * 1000 : since > maxAgeMs;
      if (due && onPath(freshclam)) {
        log("upload scan: updating virus signatures (freshclam)");
        const r = await runCapture(freshclam, ["--stdout", `--datadir=${dbDir}`], updateTimeoutMs);
        try {
          writeFileSync(stamp, String(Date.now()));
        } catch {
          /* a read-only volume shows up below as missing signatures */
        }
        if (r.code !== 0) log(`upload scan: freshclam failed (${(r.stderr || r.stdout).trim().split("\n").pop()})`);
      }
      const at = signaturesAt(dbDir);
      if (at === null) {
        return { ok: false, detail: "no virus signatures yet (freshclam couldn't download them; it tries again hourly)", signaturesAt: null };
      }
      return { ok: true, detail: "", signaturesAt: at };
    },
    async scan(path, sizeBytes) {
      const r = await runCapture(
        clamscan,
        [
          "--no-summary",
          "--infected",
          `--database=${dbDir}`,
          `--max-filesize=${maxMb}M`,
          `--max-scansize=${maxMb}M`,
          // Its default stops after two minutes and calls what it read clean.
          "--max-scantime=3600000",
          "--",
          path,
        ],
        scanTimeoutMs,
      );
      const parsed = parseClamscan(r);
      if (parsed.verdict !== "clean") return parsed;
      const at = signaturesAt(dbDir);
      const when = at ? ` (signatures of ${new Date(at).toISOString().slice(0, 10)})` : "";
      const partial = sizeBytes > maxMb * 1024 * 1024 ? `; only the first ${maxMb} MB could be scanned` : "";
      return { verdict: "clean", detail: `No threats found by ClamAV${when}${partial}.` };
    },
  };
}

/** Atomic (temp + rename) so the gate never reads half a file. */
export function writeHeartbeat(dir, info) {
  const target = join(dir, HEARTBEAT_FILE);
  const tmp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ranAt: new Date().toISOString(), scanner: "clamav", ...info }));
  renameSync(tmp, target);
}
