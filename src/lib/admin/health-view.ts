/**
 * The Health tab's data shaping (step 2b of moving the console): the status
 * cards, scheduled jobs' lines and their "when" form, storage, external APIs
 * and the activity log. Ported from curator.html (renderHealth, jobRender,
 * jobWhenHtml/Read, renderEvents); no React here, so it can be tested.
 */

export type Status = "ok" | "warning" | "critical" | "";

export interface Health {
  overall: "ok" | "warning" | "critical";
  checkedAt: number;
  publicSite: { reachable: boolean; responseMs?: number | null; error?: string | null };
  jellyfin: { reachable: boolean; responseMs?: number | null; version?: string | null; error?: string | null };
  sessions: { playing: number; signedIn: number } | null;
  storage: { freeBytes: number | null; totalBytes: number | null; freeFraction: number | null; error?: string | null };
  conversionQueue: { pending: number; running: number; failedRecent: number; stuck: Array<{ title: string; hoursRunning: number }> };
  scraping: { recentFailures: Array<{ sourceId: string; error: string | null; finishedAt: number }> };
  lastLibraryScan: { triggeredAt: number | null };
  database: { sizeBytes: number };
  uploadScanner?: {
    lastRunAt: number | null;
    waiting: number;
    stalled: boolean;
    deferred?: string | null;
    infected?: number;
    signaturesAt?: number | null;
  } | null;
  storageBreakdown?: { scrapedDataBytes: number; cachedApiDataBytes: number; otherDataBytes: number; codebaseBytes: number } | null;
  externalApis?: Array<{ source: string; successCount: number; failureCount: number; dailyCap: number | null }>;
  omdbBackfill?: { totalKnown: number; missing: number; stale: number; lastTickAt: number | null; lastTickProcessed: number } | null;
  wikipediaBackfill?: { totalKnown: number; neverAttempted: number; lastTickAt: number | null; lastTickProcessed: number } | null;
  libraryNotify?: { knownItemCount: number; lastTickAt: number | null; lastTickNewItems: number } | null;
  tvNotify?: {
    knownGroupCount: number;
    lastTickAt: number | null;
    lastTickNewShows: number;
    lastTickEpisodeNotifications: number;
  } | null;
}

export function fmtAgo(ms: number | null | undefined, now: number): string {
  if (ms === null || ms === undefined) return "never";
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function headline(overall: Health["overall"]): string {
  return overall === "ok"
    ? "Everything looks fine"
    : overall === "warning"
      ? "Mostly fine, a couple of things worth a look"
      : "Something needs attention now";
}

export interface Card {
  label: string;
  value: string;
  sub: string;
  status: Status;
}

export function healthCards(h: Health, now: number): Card[] {
  const cards: Card[] = [];
  cards.push({
    label: "Public site",
    value: h.publicSite.reachable ? "Reachable" : "Unreachable",
    sub: h.publicSite.reachable
      ? h.publicSite.responseMs != null
        ? `${h.publicSite.responseMs} ms round trip`
        : ""
      : h.publicSite.error || "No response",
    status: h.publicSite.reachable ? "ok" : "critical",
  });
  cards.push({
    label: "Jellyfin",
    value: h.jellyfin.reachable ? "Reachable" : "Unreachable",
    sub: h.jellyfin.reachable
      ? `${h.jellyfin.responseMs ?? "?"} ms${h.jellyfin.version ? ` · v${h.jellyfin.version}` : ""}`
      : h.jellyfin.error || "No response",
    status: h.jellyfin.reachable ? "ok" : "critical",
  });
  cards.push({
    label: "Viewers now",
    value: h.sessions ? `${h.sessions.playing} streaming` : "—",
    sub: h.sessions ? `${h.sessions.signedIn} signed in total` : "Unavailable (Jellyfin unreachable)",
    status: "ok",
  });
  const free = h.storage.freeFraction;
  cards.push({
    label: "Storage free",
    value: h.storage.freeBytes != null ? fmtBytes(h.storage.freeBytes) : "—",
    sub: h.storage.totalBytes != null ? `${Math.round((free ?? 0) * 100)}% free of ${fmtBytes(h.storage.totalBytes)}` : h.storage.error || "",
    status: free == null ? "" : free < 0.1 ? "critical" : free < 0.2 ? "warning" : "ok",
  });
  const q = h.conversionQueue;
  cards.push({
    label: "Conversion queue",
    value: String(q.pending + q.running),
    sub: `${q.running} running, ${q.pending} waiting${q.failedRecent > 0 ? ` · ${q.failedRecent} failed this week` : ""}`,
    status: q.stuck.length > 0 ? "critical" : q.failedRecent > 0 ? "warning" : "ok",
  });
  const fails = h.scraping.recentFailures.length;
  cards.push({
    label: "Accolades scraping",
    value: fails > 0 ? `${fails} failed` : "Clean",
    sub: fails > 0 ? "in the last 7 days" : "no failures in the last 7 days",
    status: fails > 0 ? "warning" : "ok",
  });
  cards.push({
    label: "Last library scan",
    value: h.lastLibraryScan.triggeredAt ? fmtAgo(h.lastLibraryScan.triggeredAt, now) : "Never recorded",
    sub: "",
    status: h.lastLibraryScan.triggeredAt ? "" : "warning",
  });
  cards.push({ label: "Database size", value: fmtBytes(h.database.sizeBytes), sub: "", status: "" });
  const us = h.uploadScanner;
  if (us) {
    let note = us.stalled
      ? `${us.waiting} upload${us.waiting === 1 ? "" : "s"} waiting and nothing is scanning them — see the worker's log`
      : us.lastRunAt
        ? us.waiting
          ? `${us.waiting} waiting for a scan${us.deferred ? ` (held off: ${us.deferred})` : ""}`
          : "nothing waiting"
        : "no sign the worker's scanner has run — uploads cannot be approved until it does";
    if (us.infected) note += ` · ${us.infected} failed the scan — reject ${us.infected === 1 ? "it" : "them"} in Uploads`;
    if (us.signaturesAt) note += ` · signatures of ${fmtAgo(us.signaturesAt, now)}`;
    cards.push({
      label: "Upload scanner",
      value: us.lastRunAt ? fmtAgo(us.lastRunAt, now) : "Not set up",
      sub: note,
      status: us.stalled || us.infected ? "warning" : "",
    });
  }
  return cards;
}

export function issues(h: Health, now: number): Array<{ title: string; meta: string }> {
  return [
    ...h.conversionQueue.stuck.map((j) => ({ title: `Stuck conversion: ${j.title}`, meta: `Running ${j.hoursRunning} hours — check the Worker tab` })),
    ...h.scraping.recentFailures.map((f) => ({ title: `Scrape failed: ${f.sourceId}`, meta: `${f.error || "Unknown error"} · ${fmtAgo(f.finishedAt, now)}` })),
  ];
}

export function storageRows(sb: NonNullable<Health["storageBreakdown"]>): Array<{ name: string; note: string; bytes: number; percent: number }> {
  const rows = [
    { name: "Scraped data", bytes: sb.scrapedDataBytes, note: "reviews, books, lists — the actual scraped text" },
    { name: "Cached API data", bytes: sb.cachedApiDataBytes, note: "ratings, cast/director bios — kept so we don't re-fetch" },
    { name: "Other database", bytes: sb.otherDataBytes, note: "users, comments, notifications, jobs, locks" },
    { name: "Codebase", bytes: sb.codebaseBytes, note: "the app itself — same on every deploy, not your data" },
  ];
  const max = Math.max(...rows.map((r) => r.bytes || 0)) || 1;
  return rows.map((r) => ({ ...r, percent: Math.round(((r.bytes || 0) / max) * 100) }));
}

export function apiRow(a: { source: string; successCount: number; failureCount: number; dailyCap: number | null }): {
  source: string;
  percent: number | null;
  level: "" | "warn" | "crit";
  text: string;
} {
  const total = a.successCount + a.failureCount;
  const fraction = a.dailyCap ? Math.min(1, total / a.dailyCap) : null;
  let text = a.dailyCap ? `${total} / ${a.dailyCap} today` : `${total} call${total === 1 ? "" : "s"} today`;
  if (a.failureCount > 0) text += ` · ${a.failureCount} failed`;
  return {
    source: a.source,
    percent: fraction == null ? null : Math.round(fraction * 100),
    level: fraction == null ? "" : fraction >= 0.9 ? "crit" : fraction >= 0.7 ? "warn" : "",
    text,
  };
}

/** The catch-up and notification loops, one plain line each. */
export function loopLines(h: Health, now: number): string[] {
  const out: string[] = [];
  const last = (at: number | null, what: string) => (at ? ` · last ${what} ${fmtAgo(at, now)}` : " · not run yet");
  if (h.omdbBackfill) {
    const b = h.omdbBackfill;
    out.push(
      `OMDb catch-up: ${b.missing} movie(s) never rated, ${b.stale} overdue for a refresh, of ${b.totalKnown} known` +
        (b.lastTickAt ? `${last(b.lastTickAt, "batch")} (${b.lastTickProcessed} processed)` : last(null, "")),
    );
  }
  if (h.wikipediaBackfill) {
    const b = h.wikipediaBackfill;
    out.push(
      `Wikipedia catch-up: ${b.neverAttempted} movie(s) never tried, of ${b.totalKnown} known` +
        (b.lastTickAt ? `${last(b.lastTickAt, "batch")} (${b.lastTickProcessed} processed)` : last(null, "")),
    );
  }
  if (h.libraryNotify) {
    const n = h.libraryNotify;
    out.push(`New-item notifications: ${n.knownItemCount} movie(s) tracked` + (n.lastTickAt ? `${last(n.lastTickAt, "check")} (${n.lastTickNewItems} notified)` : last(null, "")));
  }
  if (h.tvNotify) {
    const n = h.tvNotify;
    out.push(
      `TV notifications: ${n.knownGroupCount} show(s) tracked` +
        (n.lastTickAt
          ? `${last(n.lastTickAt, "check")} (${n.lastTickNewShows} new show(s), ${n.lastTickEpisodeNotifications} episode update(s))`
          : last(null, "")),
    );
  }
  return out;
}

/* ---- scheduled jobs --------------------------------------------------- */

export type Cadence = "daily" | "weekly" | "monthly";

export interface Schedule {
  cadence: Cadence;
  hour: number;
  minute: number;
  weekday?: number | null;
  monthDay?: number | null;
}

export interface Run {
  id: string;
  trigger: "schedule" | "manual";
  status: "running" | "done" | "failed";
  started_at: number;
  finished_at: number | null;
  summary: string | null;
  error: string | null;
}

export interface Job {
  id: string;
  kind: string;
  label: string;
  description: string;
  schedule: Schedule;
  scheduleText: string;
  enabled: boolean;
  skipIfPlaying: boolean;
  builtin: boolean;
  runner: string;
  nextRunAt: number;
  waitingSince: number | null;
  runRequested: boolean;
  running: boolean;
  runs: Run[];
}

export interface JobKind {
  kind: string;
  label: string;
  description: string;
  runner: string;
  params: Array<{ name: string; label: string; options: Array<{ value: string; label: string }> }>;
}

export const JOB_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Times are shown in India time whatever this device's clock says: that is what the schedule is kept in. */
export function jobTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function jobAgo(ms: number, now: number): string {
  const min = Math.round((now - ms) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.round(hr / 24)} d ago`;
}

/** Where a job runs, when that's worth saying. */
export function runnerNote(runner: string): string | null {
  if (runner === "host") return "on this computer";
  if (runner === "worker") return "in the worker";
  if (runner === "loop") return "in the worker, whenever there is work";
  return null;
}

/** A worker loop has no time to set or press: it runs whenever there is work. */
export function isLoop(job: Pick<Job, "runner">): boolean {
  return job.runner === "loop";
}

export function nextLine(job: Job): { tone: "" | "wait"; text: string } {
  if (isLoop(job)) return { tone: "", text: "Runs whenever there is work" };
  if (!job.enabled) return { tone: "", text: "Paused" };
  if (job.waitingSince) return { tone: "wait", text: `Waiting — someone is watching. Looks again ${jobTime(job.nextRunAt)}` };
  return { tone: "", text: `Next: ${jobTime(job.nextRunAt)}` };
}

export function lastLine(job: Job, now: number): { tone: "" | "ok" | "bad" | "wait"; head: string; rest: string } {
  const r = job.runs[0];
  if (job.running && r) return { tone: "wait", head: "Running now", rest: `, started ${jobAgo(r.started_at, now)}` };
  if (job.runRequested) return { tone: "wait", head: "Queued", rest: " — starts within a minute" };
  if (!r) return { tone: "", head: "", rest: "Has not run yet" };
  const when = jobAgo(r.started_at, now) + (r.trigger === "manual" ? ", run by hand" : "");
  return r.status === "failed"
    ? { tone: "bad", head: "Failed", rest: ` ${when}: ${r.error || "no reason given"}` }
    : { tone: "ok", head: "Done", rest: ` ${when}${r.summary ? `: ${r.summary}` : ""}` };
}

export interface WhenForm {
  cadence: Cadence;
  time: string;
  weekday: number;
  monthDay: number;
}

export function whenFormFrom(sch: Schedule | null | undefined): WhenForm {
  const s = sch ?? { cadence: "weekly" as Cadence, hour: 9, minute: 0, weekday: 4, monthDay: 1 };
  return {
    cadence: s.cadence,
    time: `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`,
    weekday: s.weekday ?? 4,
    monthDay: s.monthDay ?? 1,
  };
}

/** The body the schedule API wants (snake_case month_day, as the old console sent). */
export function whenBody(f: WhenForm): { cadence: Cadence; hour: number; minute: number; weekday: number; month_day: number } {
  const [h, m] = f.time.split(":");
  return { cadence: f.cadence, hour: Number(h), minute: Number(m), weekday: f.weekday, month_day: f.monthDay };
}

/** While anything is running or queued, look again shortly so "Running now" turns into its result. */
export function shouldPoll(jobs: readonly Job[]): boolean {
  return jobs.some((j) => j.running || j.runRequested);
}

/* ---- activity log ----------------------------------------------------- */

export interface LogEvent {
  id?: string;
  severity: string;
  source: string;
  message: string;
  created_at: number;
  detail: string | null;
  username?: string | null;
  item_id?: string | null;
}

export const LOG_CATEGORIES = [
  ["", "All categories"],
  ["internal_api", "Internal API"],
  ["external_api", "External API"],
  ["playback", "Playback"],
  ["client", "Client"],
  ["media_job", "Conversion"],
  ["scrape_job", "Scraping"],
  ["upload", "Upload scan"],
] as const;

export const LOG_SEVERITIES = [
  ["", "All severities"],
  ["critical", "Critical"],
  ["error", "Error"],
  ["warning", "Warning"],
  ["info", "Info"],
] as const;

export function eventDetail(e: LogEvent): string {
  let detail = "";
  if (e.detail) {
    try {
      detail = JSON.stringify(JSON.parse(e.detail), null, 2);
    } catch {
      detail = e.detail;
    }
  }
  if (!detail) return "";
  return detail + (e.username ? `\n\nuser: ${e.username}` : "") + (e.item_id ? `\nitem: ${e.item_id}` : "");
}

export function eventsQuery(category: string, severity: string, limit = 40): string {
  const p = new URLSearchParams();
  if (category) p.set("category", category);
  if (severity) p.set("severity", severity);
  p.set("limit", String(limit));
  return `/api/admin/events?${p.toString()}`;
}
