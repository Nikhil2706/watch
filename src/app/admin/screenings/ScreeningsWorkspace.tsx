"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { screeningLine, screeningRequest, searchFilms, type LibraryHit, type Screening, type ScreeningForm } from "@/lib/admin/screenings-view";

import { useToasts } from "../Toasts";

/**
 * The Screening Room: an expiring link that lets one person watch one film,
 * with no account and no way to wander the library. The link is shown once:
 * only its hash is stored. Ported from curator.html's Screening Room tab.
 */

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const START: ScreeningForm = { label: "", message: "", windowHours: "48", expiryDays: "7", maxDevices: "2", startsOn: "open" };

export function ScreeningsWorkspace() {
  const { show } = useToasts();
  const library = useRef<Promise<LibraryHit[]> | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LibraryHit[] | null>(null);
  const [chosen, setChosen] = useState<LibraryHit | null>(null);
  const [form, setForm] = useState<ScreeningForm>(START);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [list, setList] = useState<Screening[] | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await adminApi<{ screenings: Screening[] }>("/api/admin/screenings");
      setList(d.screenings ?? []);
    } catch (e) {
      show("err", message(e));
    }
  }, [show]);

  useEffect(() => {
    void load();
  }, [load]);

  function onSearch(q: string) {
    setQuery(q);
    setChosen(null);
    // The whole library, fetched once: a personal library is cheap enough to hold and filter here.
    library.current ??= adminApi<{ items: LibraryHit[] }>("/api/admin/library/browse").then((d) => d.items ?? []);
    library.current.then((items) => setHits(searchFilms(items, q))).catch((e) => show("err", message(e)));
  }

  async function create() {
    const req = screeningRequest(chosen?.id ?? null, form);
    if ("error" in req) {
      show("err", req.error);
      return;
    }
    setBusy(true);
    try {
      const d = await adminApi<{ url: string }>("/api/admin/screenings", { method: "POST", body: req.body });
      setUrl(d.url);
      await load();
    } catch (e) {
      show("err", message(e));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(id: string) {
    try {
      await adminApi(`/api/admin/screenings/${encodeURIComponent(id)}`, { method: "DELETE" });
      show("ok", "Withdrawn. The link stops working now.");
      await load();
    } catch (e) {
      show("err", message(e));
    }
  }

  return (
    <div className="adm-invites">
      <section className="adm-card">
        <h2 className="adm-card-title">Screening Room</h2>
        <p className="hint">
          An expiring link that lets one person watch one film, with no account and no way to wander the library. The link is shown once and
          cannot be recovered — only its hash is stored.
        </p>
        <div className="adm-row">
          <label>
            Film
            <input value={query} placeholder="search the library" spellCheck={false} autoComplete="off" onChange={(e) => onSearch(e.target.value)} />
          </label>
          <label className="narrow">
            For
            <input value={form.label} placeholder="Ana" spellCheck={false} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
        </div>
        {chosen ? (
          <p className="hint">Chosen: {chosen.name}</p>
        ) : hits === null ? null : hits.length ? (
          <div className="adm-acts">
            {hits.map((h) => (
              <button
                key={h.id}
                type="button"
                className="secondary"
                onClick={() => {
                  setChosen(h);
                  setQuery(h.name);
                }}
              >
                {h.name}
                {h.year ? ` (${h.year})` : ""}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">Nothing matched.</p>
        )}
        <div className="adm-row">
          <label>
            Note (shown on the landing page)
            <input value={form.message} placeholder="why you are sending it" spellCheck={false} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          </label>
          <label className="narrow">
            Window (hours)
            <input type="number" min={1} value={form.windowHours} onChange={(e) => setForm({ ...form, windowHours: e.target.value })} />
          </label>
          <label className="narrow">
            Link dies unopened (days)
            <input type="number" min={1} value={form.expiryDays} onChange={(e) => setForm({ ...form, expiryDays: e.target.value })} />
          </label>
          <label className="narrow">
            Max devices
            <input type="number" min={1} value={form.maxDevices} onChange={(e) => setForm({ ...form, maxDevices: e.target.value })} />
          </label>
        </div>
        <div className="adm-row adm-invite-foot">
          <label className="narrow">
            Clock starts
            <select value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value as ScreeningForm["startsOn"] })}>
              <option value="open">when they open it</option>
              <option value="play">when they press play</option>
            </select>
          </label>
          <span className="adm-grow" />
          <button type="button" disabled={busy} onClick={create}>
            {busy ? "Creating…" : "Create screening"}
          </button>
        </div>
        {url ? (
          <>
            <p className="hint">Copy this now — it is not shown again:</p>
            <div className="adm-row adm-link-out">
              <input readOnly value={url} onFocus={(e) => e.target.select()} aria-label="Screening link" />
            </div>
          </>
        ) : null}
        <p className="hint">A screening deliberately ignores the discovery filters, so an excluded or not-yet-released title can still be sent. That is not a bug.</p>
      </section>
      <section className="adm-card">
        <h2 className="adm-card-title">Screenings</h2>
        {list === null ? (
          <p className="hint">Loading…</p>
        ) : !list.length ? (
          <p className="hint">No screenings yet.</p>
        ) : (
          <div className="adm-rows">
            {list.map((r) => (
              <div key={r.id} className="adm-row">
                <span className="adm-grow">{screeningLine(r)}</span>
                {r.revoked ? null : (
                  <button type="button" className="secondary" onClick={() => withdraw(r.id)}>
                    Withdraw
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
