"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import {
  apiRow,
  eventDetail,
  eventsQuery,
  fmtAgo,
  fmtBytes,
  headline,
  healthCards,
  issues,
  isLoop,
  JOB_DAYS,
  lastLine,
  LOG_CATEGORIES,
  LOG_SEVERITIES,
  loopLines,
  nextLine,
  runnerNote,
  shouldPoll,
  storageRows,
  whenBody,
  whenFormFrom,
  jobTime,
  type Health,
  type Job,
  type JobKind,
  type LogEvent,
  type WhenForm,
} from "@/lib/admin/health-view";

import { useToasts } from "../Toasts";

/**
 * The Health tab: is the site, the media server and the background work all
 * behaving; every scheduled job with Run now, Pause, Reschedule and New job;
 * what uses the disk; today's outside API calls; and the activity log.
 * Ported from curator.html's Health tab. Health and the log refresh every 30
 * seconds while the page is open; jobs every 15 while one is running.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function WhenFields({ value, onChange }: { value: WhenForm; onChange: (f: WhenForm) => void }) {
  return (
    <div className="adm-row">
      <label>
        How often
        <select value={value.cadence} onChange={(e) => onChange({ ...value, cadence: e.target.value as WhenForm["cadence"] })}>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
      </label>
      {value.cadence === "weekly" ? (
        <label>
          On
          <select value={value.weekday} onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}>
            {JOB_DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {value.cadence === "monthly" ? (
        <label>
          On the
          <select value={value.monthDay} onChange={(e) => onChange({ ...value, monthDay: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label>
        At (India time)
        <input type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value })} />
      </label>
    </div>
  );
}

function JobRow({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const { show } = useToasts();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<WhenForm>(() => whenFormFrom(job.schedule));
  const [polite, setPolite] = useState(job.skipIfPlaying);
  const [busy, setBusy] = useState(false);
  const url = `/api/admin/schedule/${encodeURIComponent(job.id)}`;
  const now = Date.now();
  const next = nextLine(job);
  const last = lastLine(job, now);
  const where = runnerNote(job.runner);

  async function call(fn: () => Promise<string>) {
    setBusy(true);
    try {
      show("ok", await fn());
      setEditing(false);
      onChanged();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`adm-job${job.enabled ? "" : " off"}`}>
      <div className="adm-row adm-job-top">
        <div className="adm-grow">
          <div className="adm-job-name">
            {job.label} {where ? <span className="hint">· {where}</span> : null}
          </div>
          {isLoop(job) ? null : <div className="hint">{job.scheduleText}</div>}
          <div className="adm-job-meta">
            <span className={next.tone ? `adm-${next.tone}` : undefined}>{next.text}</span>
            <br />
            {last.head ? <span className={`adm-${last.tone}`}>{last.head}</span> : null}
            {last.rest}
          </div>
        </div>
        <div className="adm-acts">
          {isLoop(job) ? (
            <button type="button" className="secondary" onClick={() => setEditing((o) => !o)}>
              {editing ? "Close" : "History"}
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || job.running || job.runRequested}
                onClick={() =>
                  call(async () => {
                    const r = await adminApi<{ message?: string }>(url, { method: "POST" });
                    return r?.message || `Started “${job.label}”.`;
                  })
                }
              >
                Run now
              </button>
              <button type="button" className="secondary" aria-expanded={editing} onClick={() => setEditing((o) => !o)}>
                Reschedule
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  call(async () => {
                    await adminApi(url, { method: "PATCH", body: { enabled: !job.enabled } });
                    return job.enabled ? "Paused. It will not run until you resume it." : "Resumed.";
                  })
                }
              >
                {job.enabled ? "Pause" : "Resume"}
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <div className="adm-job-edit">
          {isLoop(job) ? null : (
            <>
              <WhenFields value={form} onChange={setForm} />
              <label className="adm-check">
                <input type="checkbox" checked={polite} onChange={(e) => setPolite(e.target.checked)} />
                <span>Wait if someone is watching</span>
              </label>
              <div className="adm-acts">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    call(async () => {
                      await adminApi(url, { method: "PATCH", body: { ...whenBody(form), skip_if_playing: polite } });
                      return "Rescheduled.";
                    })
                  }
                >
                  Save
                </button>
                <button type="button" className="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
                {job.builtin ? null : (
                  <button
                    type="button"
                    className="adm-danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Delete “${job.label}”? It stops running and its history goes with it.`)) return;
                      void call(async () => {
                        await adminApi(url, { method: "DELETE" });
                        return "Deleted.";
                      });
                    }}
                  >
                    Delete job
                  </button>
                )}
              </div>
            </>
          )}
          {job.runs.length ? (
            <div className="adm-job-history">
              {job.runs.map((r) => (
                <div key={r.id}>
                  {jobTime(r.started_at)} —{" "}
                  {r.status === "running" ? (
                    "running"
                  ) : r.status === "failed" ? (
                    <>
                      <span className="adm-bad">failed</span>: {r.error ?? ""}
                    </>
                  ) : (
                    r.summary || "done"
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="hint">No runs recorded yet.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function NewJob({ kinds, onDone }: { kinds: JobKind[]; onDone: () => void }) {
  const { show } = useToasts();
  const [kind, setKind] = useState(kinds[0]?.kind ?? "");
  const [param, setParam] = useState("");
  const [form, setForm] = useState<WhenForm>(() => whenFormFrom(null));
  const k = kinds.find((x) => x.kind === kind);
  const field = k?.params[0];

  useEffect(() => {
    setParam(field?.options[0]?.value ?? "");
  }, [kind, field]);

  async function create() {
    try {
      const r = await adminApi<{ job: { label: string; scheduleText: string } }>("/api/admin/schedule", {
        method: "POST",
        body: { ...whenBody(form), kind, params: field ? { [field.name]: param } : {} },
      });
      show("ok", `Created: ${r.job.label}. ${r.job.scheduleText}.`);
      onDone();
    } catch (e) {
      show("err", message(e));
    }
  }

  return (
    <div className="adm-panel">
      <div className="adm-row">
        <label>
          What it does
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((x) => (
              <option key={x.kind} value={x.kind}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        {field ? (
          <label>
            {field.label}
            <select value={param} onChange={(e) => setParam(e.target.value)}>
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {k ? <p className="hint">{k.description}</p> : null}
      <WhenFields value={form} onChange={setForm} />
      <div className="adm-acts">
        <button type="button" onClick={create}>
          Create job
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function HealthWorkspace() {
  const { show } = useToasts();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [kinds, setKinds] = useState<JobKind[]>([]);
  const [alwaysOn, setAlwaysOn] = useState<Array<{ label: string; every: string; where: string }>>([]);
  const [newJob, setNewJob] = useState(false);
  const [events, setEvents] = useState<LogEvent[] | null>(null);
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState("");
  const [openEvent, setOpenEvent] = useState<number | null>(null);
  const [scrape, setScrape] = useState<{ busy: boolean; note: string | null }>({ busy: false, note: null });
  const jobTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await adminApi<Health>("/api/admin/health"));
      setHealthError(null);
    } catch (e) {
      setHealthError(message(e));
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      const d = await adminApi<{ events: LogEvent[] }>(eventsQuery(category, severity));
      setEvents(d.events ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [category, severity, show]);

  const loadJobs = useCallback(async () => {
    try {
      const d = await adminApi<{ jobs: Job[]; kinds: JobKind[]; alwaysOn: Array<{ label: string; every: string; where: string }> }>("/api/admin/schedule");
      setJobs(d.jobs ?? []);
      setKinds(d.kinds ?? []);
      setAlwaysOn(d.alwaysOn ?? []);
      if (jobTimer.current) clearTimeout(jobTimer.current);
      if (shouldPoll(d.jobs ?? [])) jobTimer.current = setTimeout(() => void loadJobs(), 15000);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void loadHealth();
    void loadJobs();
    const t = setInterval(() => {
      void loadHealth();
    }, 30000);
    return () => {
      clearInterval(t);
      if (jobTimer.current) clearTimeout(jobTimer.current);
    };
  }, [loadHealth, loadJobs]);

  useEffect(() => {
    void loadEvents();
    const t = setInterval(() => void loadEvents(), 30000);
    return () => clearInterval(t);
  }, [loadEvents]);

  async function scrapeNow() {
    setScrape({ busy: true, note: null });
    try {
      const d = await adminApi<{ started: boolean; reason?: string }>("/api/admin/scrape/run-now", { method: "POST" });
      setScrape({
        busy: false,
        note: d.started
          ? "Scraping started — this can take several minutes on a big backlog. Progress shows up in the rows below as it runs; Refresh to check in."
          : d.reason || "Could not start — a pass may already be running.",
      });
    } catch (e) {
      setScrape({ busy: false, note: `Failed to start: ${message(e)}` });
    }
  }

  const now = Date.now();

  return (
    <div className="adm-health">
      <section className="adm-card">
        <div className="adm-row adm-health-banner">
          <span className={`adm-health-dot ${healthError ? "critical" : health?.overall ?? ""}`} />
          <div className="adm-grow">
            <div className={`adm-health-headline ${healthError ? "critical" : health?.overall ?? ""}`}>
              {healthError ? "Could not load health data" : health ? headline(health.overall) : "Checking…"}
            </div>
            <div className="hint">{healthError ?? (health ? `Checked ${fmtAgo(health.checkedAt, now)}` : "")}</div>
          </div>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              void loadHealth();
              void loadEvents();
              void loadJobs();
            }}
          >
            Refresh
          </button>
        </div>
        <p className="hint">
          Whether the site, the media server and the background jobs are all behaving. Green is fine, amber is worth a look when you have a
          minute, red needs attention now.
        </p>
        {health ? (
          <>
            <div className="adm-health-grid">
              {healthCards(health, now).map((c) => (
                <div key={c.label} className={`adm-health-card${c.status ? ` ${c.status}` : ""}`}>
                  <div className="adm-hc-label">{c.label}</div>
                  <div className="adm-hc-value">{c.value}</div>
                  {c.sub ? <div className="adm-hc-sub">{c.sub}</div> : null}
                </div>
              ))}
            </div>
            {issues(health, now).length ? (
              <>
                <h3 className="adm-section">Things worth a look</h3>
                {issues(health, now).map((i) => (
                  <div key={i.title + i.meta} className="adm-issue">
                    <b>{i.title}</b>
                    <div className="hint">{i.meta}</div>
                  </div>
                ))}
              </>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="adm-card">
        <div className="adm-row">
          <div className="adm-grow">
            <h2 className="adm-card-title">Scheduled jobs</h2>
            <p className="hint">Everything that runs on a schedule. Times are India time.</p>
          </div>
          <button type="button" onClick={() => setNewJob((o) => !o)}>
            New job
          </button>
        </div>
        {newJob ? (
          <NewJob
            kinds={kinds}
            onDone={() => {
              setNewJob(false);
              void loadJobs();
            }}
          />
        ) : null}
        {jobs === null ? <p className="hint">Loading…</p> : jobs.length ? jobs.map((j) => <JobRow key={j.id} job={j} onChanged={() => void loadJobs()} />) : <p className="hint">No jobs.</p>}
        {alwaysOn.length ? (
          <details className="adm-always">
            <summary>Runs on its own, not schedulable</summary>
            <p className="hint">Each of these is part of a feature working at all, so there is no time to set.</p>
            {alwaysOn.map((a) => (
              <div key={a.label} className="adm-row adm-always-row">
                <span className="adm-grow">{a.label}</span>
                <span className="hint">
                  {a.every} · {a.where}
                </span>
              </div>
            ))}
          </details>
        ) : null}
      </section>

      {health?.storageBreakdown ? (
        <section className="adm-card">
          <h2 className="adm-card-title">Storage breakdown</h2>
          <p className="hint">What’s actually using disk — your data vs. the app running it.</p>
          {storageRows(health.storageBreakdown).map((r) => (
            <div key={r.name} className="adm-bar-row">
              <div className="adm-bar-name">
                {r.name}
                <div className="hint">{r.note}</div>
              </div>
              <div className="adm-bar">
                <div style={{ width: `${r.percent}%` }} />
              </div>
              <div className="adm-bar-count">{fmtBytes(r.bytes)}</div>
            </div>
          ))}
        </section>
      ) : null}

      {health ? (
        <section className="adm-card">
          <div className="adm-row">
            <div className="adm-grow">
              <h2 className="adm-card-title">External APIs</h2>
              <p className="hint">Today’s call usage for the outside services this site depends on.</p>
            </div>
            <button type="button" className="secondary" disabled={scrape.busy} onClick={scrapeNow}>
              {scrape.busy ? "Starting…" : "Scrape now"}
            </button>
          </div>
          {scrape.note ? <p className="hint">{scrape.note}</p> : null}
          {(health.externalApis ?? []).length ? (
            (health.externalApis ?? []).map((a) => {
              const r = apiRow(a);
              return (
                <div key={r.source} className="adm-bar-row">
                  <div className="adm-bar-name adm-upper">{r.source}</div>
                  {r.percent == null ? (
                    <div className="adm-bar adm-bar-none" />
                  ) : (
                    <div className={`adm-bar ${r.level}`}>
                      <div style={{ width: `${r.percent}%` }} />
                    </div>
                  )}
                  <div className="adm-bar-count">{r.text}</div>
                </div>
              );
            })
          ) : (
            <p className="hint">No external API calls recorded yet.</p>
          )}
          {loopLines(health, now).map((l) => (
            <p key={l} className="hint adm-loop-line">
              {l}
            </p>
          ))}
          <p className="hint">
            The OMDb/Wikipedia catch-up only does real work when you press “Scrape now” or when the catch-up job under Scheduled jobs runs — not
            continuously.
          </p>
        </section>
      ) : null}

      <section className="adm-card">
        <h2 className="adm-card-title">Recent activity log</h2>
        <p className="hint">Every external API failure, playback problem, route error and crash the site has recorded.</p>
        <div className="adm-row">
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            {LOG_CATEGORIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
            {LOG_SEVERITIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={() => void loadEvents()}>
            Refresh
          </button>
        </div>
        {events === null ? (
          <p className="hint">Loading…</p>
        ) : !events.length ? (
          <p className="hint">Nothing recorded for this filter.</p>
        ) : (
          <div className="adm-log">
            {events.map((e, i) => {
              const detail = eventDetail(e);
              const open = openEvent === i;
              return (
                <div key={e.id ?? `${e.created_at}:${i}`} className="adm-log-row">
                  <button type="button" className="adm-log-head" aria-expanded={open} disabled={!detail} onClick={() => setOpenEvent(open ? null : i)}>
                    <span className={`adm-log-dot ${e.severity}`} />
                    <span className="adm-log-source">{e.source}</span>
                    <span className="adm-log-msg">{e.message}</span>
                    <span className="hint">{fmtAgo(e.created_at, now)}</span>
                  </button>
                  {open && detail ? <pre className="adm-log-detail">{detail}</pre> : null}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
