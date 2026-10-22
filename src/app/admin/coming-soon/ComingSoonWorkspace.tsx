"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { whenLabel } from "@/lib/coming-soon-list";

import { useToasts } from "../Toasts";

/**
 * Coming soon (coming-soon.ts): announce a film or show by its IMDb id before
 * it is in the library, with a note and an expected date if you like. What is
 * scheduled to release (a film's date in Library, a show's or franchise's
 * schedule) is listed here too, and appears on the site's Coming soon by
 * itself.
 */

interface Title {
  kind: "film" | "show";
  title: string;
  year: number | null;
  overview: string | null;
  posterPath: string | null;
}

interface Announcement {
  id: string;
  imdbId: string;
  kind: "film" | "show";
  title: string;
  year: number | null;
  posterPath: string | null;
  note: string | null;
  expectedAt: number | null;
}

interface Scheduled {
  subjectType: "group" | "series" | "film";
  subjectId: string;
  nextAt: number;
  remaining: number;
  name: string;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const poster = (path: string | null) => (path ? `/api/tmdb-image?path=${encodeURIComponent(path)}&size=w185` : null);

/** "2026-10-30" from the date box (India time) -> ms, at 8 pm, when films usually go up. */
function dateToMs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T20:00:00+05:30`);
  return Number.isFinite(ms) ? ms : null;
}

const KIND: Record<Scheduled["subjectType"], string> = { film: "Film", group: "TV show", series: "Franchise" };

export function ComingSoonWorkspace() {
  const { show } = useToasts();
  const [imdb, setImdb] = useState("");
  const [found, setFound] = useState<{ imdbId: string; title: Title } | null>(null);
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ announcements: Announcement[]; scheduled: Scheduled[] }>("/api/admin/coming-soon");
      setAnnouncements(d.announcements ?? []);
      setScheduled(d.scheduled ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  async function lookUp() {
    if (!imdb.trim()) return;
    setBusy(true);
    setFound(null);
    try {
      setFound(await adminApi<{ imdbId: string; title: Title }>(`/api/admin/coming-soon?lookup=${encodeURIComponent(imdb.trim())}`));
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  async function announce() {
    if (!found) return;
    const expectedAt = date ? dateToMs(date) : null;
    if (date && expectedAt === null) {
      show("err", "That date isn't one I can read.");
      return;
    }
    setBusy(true);
    try {
      await adminApi("/api/admin/coming-soon", { method: "POST", body: { imdbId: found.imdbId, note, expectedAt } });
      show("ok", `${found.title.title} is in Coming soon.`);
      setFound(null);
      setImdb("");
      setNote("");
      setDate("");
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Announcement) {
    if (!confirm(`Take ${a.title} out of Coming soon?`)) return;
    try {
      await adminApi(`/api/admin/coming-soon?id=${encodeURIComponent(a.id)}`, { method: "DELETE" });
      show("ok", `${a.title} taken down.`);
      await load();
    } catch (e) {
      show("err", message(e));
    }
  }

  const now = Date.now();
  return (
    <div className="adm-coming">
      <section className="adm-card">
        <h2 className="adm-card-title">Announce a title</h2>
        <p className="hint">
          Paste an IMDb id (or its link) for a film or show you don&apos;t have yet. It shows in Coming soon on Home until
          it&apos;s in the library and showing.
        </p>
        <div className="adm-row">
          <input
            className="adm-grow"
            placeholder="tt0111161, or the IMDb link"
            value={imdb}
            onChange={(e) => setImdb(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void lookUp()}
          />
          <button type="button" disabled={busy || !imdb.trim()} onClick={() => void lookUp()}>
            Look up
          </button>
        </div>
        {found ? (
          <div className="adm-coming-found">
            {poster(found.title.posterPath) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={poster(found.title.posterPath)!} alt="" />
            ) : null}
            <div className="adm-grow">
              <p>
                <b>{found.title.title}</b> {found.title.year ? `(${found.title.year})` : null} ·{" "}
                {found.title.kind === "show" ? "TV show" : "Film"}
              </p>
              {found.title.overview ? <p className="hint">{found.title.overview}</p> : null}
              <label>
                Note (optional, shown with it)
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
              </label>
              <label>
                Expected (optional)
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <div className="adm-row">
                <button type="button" disabled={busy} onClick={() => void announce()}>
                  Announce
                </button>
                <button type="button" className="secondary" onClick={() => setFound(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">Announced</h2>
        {announcements === null ? (
          <p className="hint">Loading…</p>
        ) : !announcements.length ? (
          <p className="hint">Nothing announced.</p>
        ) : (
          <div className="adm-rows">
            {announcements.map((a) => (
              <div key={a.id} className="adm-row">
                {poster(a.posterPath) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="adm-coming-thumb" src={poster(a.posterPath)!} alt="" />
                ) : null}
                <div className="adm-grow">
                  <b>{a.title}</b> {a.year ? `(${a.year})` : null} · {a.kind === "show" ? "TV show" : "Film"} ·{" "}
                  {whenLabel(a.expectedAt, now)}
                  {a.note ? <div className="hint">{a.note}</div> : null}
                </div>
                <button type="button" className="adm-danger" onClick={() => void remove(a)}>
                  Take down
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">Scheduled</h2>
        <p className="hint">
          Shown in Coming soon by themselves. A film&apos;s date is set on the film in Library; a show&apos;s or
          franchise&apos;s schedule on the show, or in Library → Franchises.
        </p>
        {!scheduled.length ? (
          <p className="hint">Nothing scheduled.</p>
        ) : (
          <div className="adm-rows">
            {scheduled.map((s) => (
              <div key={`${s.subjectType}:${s.subjectId}`} className="adm-row">
                <div className="adm-grow">
                  <b>{s.name}</b> · {KIND[s.subjectType]}
                  <div className="hint">
                    Next {whenLabel(s.nextAt, now)}
                    {s.remaining > 1 ? ` · ${s.remaining} to come` : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
