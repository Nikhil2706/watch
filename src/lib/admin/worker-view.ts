/**
 * The Worker tab's data shaping (step 2e of moving the console): one list of
 * files, from "needs work" to "done", whatever stage each is at. Ported from
 * curator.html (wkRows, WK_FILTERS, wkRenderRail); no React, so it can be
 * tested.
 *
 * Candidates carry `fix` and `reason` once PR #44 is in: "convert" (the
 * video needs re-encoding) or "audio" (only a browser audio track is
 * missing, which the worker adds without converting). Without them every
 * candidate is a conversion, as before.
 */

export interface Candidate {
  id: string;
  name: string;
  year: number | null;
  path: string;
  quality: string | null;
  fix?: "convert" | "audio";
  reason?: string;
}

export interface QueueJob {
  id: string;
  source_path: string;
  title: string;
  status: string;
  progress: number | null;
}

export interface WorkerRow {
  kind: "candidate" | "job";
  id: string;
  name: string;
  year: number | null;
  path: string;
  quality: string | null;
  reason: string | null;
  item: Candidate | null;
  status: string;
  progress: number | null;
}

export function workerRows(candidates: readonly Candidate[], jobs: readonly QueueJob[]): WorkerRow[] {
  const jobFor = (path: string) => jobs.find((j) => j.source_path === path) ?? null;
  const rows: WorkerRow[] = candidates.map((c) => {
    const job = jobFor(c.path);
    return {
      kind: "candidate",
      id: c.id,
      name: c.name,
      year: c.year,
      path: c.path,
      quality: c.quality,
      reason: c.reason ?? null,
      item: c,
      status: job ? job.status : c.fix === "audio" ? "audio" : "needs",
      progress: job ? job.progress : null,
    };
  });
  // A job whose file is no longer a candidate (converted, or moved) stays on
  // the list, or finishing a conversion would make the row vanish without trace.
  for (const j of jobs) {
    if (rows.some((r) => r.path === j.source_path)) continue;
    rows.push({ kind: "job", id: `job:${j.id}`, name: j.title, year: null, path: j.source_path, quality: null, reason: null, item: null, status: j.status, progress: j.progress });
  }
  return rows;
}

export const WORKER_FILTERS = [
  { key: "needs", label: "Needs conversion", test: (r: WorkerRow) => r.status === "needs", alert: true },
  { key: "audio", label: "Needs browser audio", test: (r: WorkerRow) => r.status === "audio", alert: false },
  { key: "running", label: "Converting", test: (r: WorkerRow) => r.status === "running" || r.status === "paused", alert: false },
  { key: "queued", label: "Queued", test: (r: WorkerRow) => r.status === "queued" || r.status === "pending", alert: false },
  { key: "failed", label: "Failed", test: (r: WorkerRow) => r.status === "failed" || r.status === "error", alert: true },
  { key: "done", label: "Done", test: (r: WorkerRow) => r.status === "done" || r.status === "complete" || r.status === "skipped", alert: false },
  { key: "all", label: "Everything", test: () => true, alert: false },
] as const;

export type WorkerFilter = (typeof WORKER_FILTERS)[number]["key"];

export function workerChips(rows: readonly WorkerRow[], on: WorkerFilter): Array<{ key: WorkerFilter; label: string; count: number; on: boolean; alert: boolean }> {
  return WORKER_FILTERS.map((f) => {
    const count = rows.filter(f.test).length;
    return { key: f.key, label: f.label, count, on: f.key === on, alert: f.alert && count > 0 };
  }).filter((c) => c.key !== "audio" || c.count > 0);
}

export function visibleWorkerRows(rows: readonly WorkerRow[], on: WorkerFilter, query: string): WorkerRow[] {
  const f = WORKER_FILTERS.find((x) => x.key === on) ?? WORKER_FILTERS[0];
  const q = query.trim().toLowerCase();
  return rows
    .filter((r) => f.test(r) && (!q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function workerDot(r: Pick<WorkerRow, "status">): "danger" | "accent" | "" | "warn" {
  if (r.status === "failed" || r.status === "error") return "danger";
  if (r.status === "running" || r.status === "paused") return "accent";
  if (r.status === "done" || r.status === "complete" || r.status === "skipped") return "";
  return "warn";
}

export function workerSub(r: WorkerRow): string {
  if (r.status === "running" || r.status === "paused") return `${r.status} ${r.progress ?? 0}%`;
  if (r.status === "needs" || r.status === "audio") return r.reason || r.quality || "would transcode";
  return r.status;
}
