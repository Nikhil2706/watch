"use client";

import { useCallback, useEffect, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { bestFirst, freshCandidates, mentionBadge, mentions } from "@/lib/admin/accolades-view";

import { useToasts } from "../Toasts";
import { Reader } from "./Reader";
import { RichText } from "./RichText";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A film can be linked to a hundred articles; the choosing is further down. */
const ARTICLES_FEW = 6;

interface Detail {
  imdbId: string;
  articles: Array<{ id: string; title: string; source_id: string; link: { id: string } }>;
  blurbCandidates: Array<{ id: string; passage_text: string; source_name: string }>;
  accoladeMentions: Array<{ id: string; accolade_label: string | null; accolade_rank: number | null; article_title: string; source_name: string }>;
  curatorAccoladeMentions: Array<{ id: string; slot: number; accolade_name: string }>;
  triviaCandidates: Array<{ id: string; fact_text: string; article_title: string }>;
  triviaSelections: Array<{ id: string; text: string; sourceLabel: string; custom: boolean }>;
  lock: {
    locked_blurb_candidate_id?: string | null;
    locked_blurb_text?: string | null;
    locked_blurb_source_label?: string | null;
    locked_blurb_source_url?: string | null;
    locked_accolade_link_id?: string | null;
    locked_accolade_entry_id?: string | null;
  } | null;
}

/**
 * One film's material: the articles that mention it, the blurb under its
 * poster, the accolade it shows and its trivia. Each is automatic until
 * something is chosen here.
 */
export function FilmPane({ imdbId, name, onChanged }: { imdbId: string; name: string; onChanged: () => void }) {
  const { show } = useToasts();
  const [d, setD] = useState<Detail | null>(null);
  const [allBlurbs, setAllBlurbs] = useState(false);
  const [allTrivia, setAllTrivia] = useState(false);
  const [allArticles, setAllArticles] = useState(false);
  const [blurb, setBlurb] = useState("");
  const [blurbSource, setBlurbSource] = useState("");
  const [blurbUrl, setBlurbUrl] = useState("");
  const [fact, setFact] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const base = `/api/admin/accolades/film/${encodeURIComponent(imdbId)}`;

  const load = useCallback(async () => {
    try {
      const data = await adminApi<Detail>(base);
      setD(data);
      setBlurb(data.lock?.locked_blurb_text ?? "");
      setBlurbSource(data.lock?.locked_blurb_source_label ?? "");
      setBlurbUrl(data.lock?.locked_blurb_source_url ?? "");
    } catch (e) {
      show("err", message(e));
    }
  }, [base, show]);

  useEffect(() => {
    setD(null);
    setAllBlurbs(false);
    setAllTrivia(false);
    setAllArticles(false);
    setReading(null);
    void load();
  }, [load]);

  /** Do something, then reload this film and the rail's counts. */
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) show("ok", ok);
      await load();
      onChanged();
    } catch (e) {
      show("err", message(e));
    }
  };

  if (!d) return <p className="hint">Loading…</p>;

  const lock = d.lock ?? {};
  const blurbLocked = Boolean(lock.locked_blurb_candidate_id || lock.locked_blurb_text);
  const accoladeLocked = Boolean(lock.locked_accolade_link_id || lock.locked_accolade_entry_id);
  const curated = d.triviaSelections.length > 0;
  const blurbs = bestFirst(freshCandidates(d.blurbCandidates, (c) => c.passage_text, []), (c) => c.passage_text, allBlurbs, 3);
  const trivia = bestFirst(
    freshCandidates(d.triviaCandidates, (t) => t.fact_text, d.triviaSelections.map((t) => t.text)),
    (t) => t.fact_text,
    allTrivia,
    5,
  );
  const list = mentions(d.accoladeMentions, d.curatorAccoladeMentions);

  const fetchWikipedia = async () => {
    setFetching(true);
    await act(() => adminApi("/api/admin/accolades/fetch-wikipedia", { method: "POST", body: { imdb_id: imdbId } }), "Wikipedia fetched.");
    setFetching(false);
  };

  return (
    <div className="adm-ac-film">
      <section className="adm-card">
        <div className="adm-row">
          <h2 className="adm-card-title adm-grow">
            {name} <span className="hint">{imdbId}</span>
          </h2>
          <button type="button" className="secondary" disabled={fetching} onClick={() => void fetchWikipedia()}>
            {fetching ? "Fetching…" : "Fetch Wikipedia data"}
          </button>
        </div>
        <h3 className="adm-section">Linked articles</h3>
        {!d.articles.length ? (
          <p className="hint">Nothing found yet.</p>
        ) : (
          <div className="adm-rows">
            {(allArticles ? d.articles : d.articles.slice(0, ARTICLES_FEW)).map((a) => (
              <div key={a.link.id} className="adm-row">
                <div className="adm-grow">
                  {a.title} <span className="hint">— {a.source_id}</span>
                </div>
                <button type="button" className="secondary" onClick={() => setReading(reading === a.id ? null : a.id)}>
                  {reading === a.id ? "Close" : "Read full text"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (!confirm("Unlink this article from this film? The article stays; only this mention goes.")) return;
                    void act(() => adminApi(`/api/admin/accolades/article/${encodeURIComponent(a.id)}/links/${encodeURIComponent(a.link.id)}`, { method: "DELETE" }), "Unlinked.");
                  }}
                >
                  Unlink
                </button>
              </div>
            ))}
            {!allArticles && d.articles.length > ARTICLES_FEW ? (
              <button type="button" className="secondary" onClick={() => setAllArticles(true)}>
                Show all {d.articles.length}
              </button>
            ) : null}
          </div>
        )}
        {reading ? <Reader articleId={reading} film={{ imdbId, name }} onClose={() => setReading(null)} onSaved={() => void load().then(onChanged)} /> : null}
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">
          Blurb <Pill on={blurbLocked} onText="Locked" />
        </h2>
        {!d.blurbCandidates.length ? <p className="hint">No candidates yet.</p> : null}
        {blurbs.shown.map((c) => (
          <div key={c.id} className={`adm-ac-option${lock.locked_blurb_candidate_id === c.id ? " picked" : ""}`}>
            <div className="adm-grow">
              <div className="adm-ac-quote">“{c.passage_text}”</div>
              <div className="hint">{c.source_name}</div>
            </div>
            <button type="button" className="secondary" onClick={() => void act(() => adminApi(`${base}/lock-blurb`, { method: "POST", body: { candidate_id: c.id } }), "Blurb locked.")}>
              Use this
            </button>
          </div>
        ))}
        {blurbs.hidden ? (
          <button type="button" className="secondary" onClick={() => setAllBlurbs(true)}>
            Show the other {blurbs.hidden}
          </button>
        ) : null}
        <label className="adm-ac-label">Or write your own — or paste one copied from a site we don’t scrape</label>
        <RichText value={blurb} onChange={setBlurb} placeholder="Type or paste a blurb…" />
        <div className="adm-row">
          <input className="adm-grow" value={blurbSource} placeholder="Source name (optional, e.g. 'Roger Ebert')" onChange={(e) => setBlurbSource(e.target.value)} />
          <input className="adm-grow" value={blurbUrl} placeholder="Review link (optional)" onChange={(e) => setBlurbUrl(e.target.value)} />
        </div>
        <div className="adm-row">
          <button
            type="button"
            onClick={() => {
              if (!blurb.trim()) return show("err", "Type a blurb first.");
              void act(
                () => adminApi(`${base}/lock-blurb`, { method: "POST", body: { text: blurb.trim(), source_label: blurbSource.trim() || undefined, source_url: blurbUrl.trim() || undefined } }),
                "Blurb locked.",
              );
            }}
          >
            Lock this blurb
          </button>
          <button type="button" className="secondary" disabled={!blurbLocked} onClick={() => void act(() => adminApi(`${base}/lock-blurb`, { method: "DELETE" }), "Back to automatic.")}>
            Back to auto
          </button>
        </div>
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">
          Accolades <Pill on={accoladeLocked} onText="Locked" />
        </h2>
        {!list.length ? <p className="hint">No accolade mentions yet.</p> : null}
        {list.map((m) => {
          const picked = (m.kind === "link" && lock.locked_accolade_link_id === m.id) || (m.kind === "entry" && lock.locked_accolade_entry_id === m.id);
          const badge = mentionBadge(m.label);
          return (
            <div key={`${m.kind}:${m.id}`} className={`adm-ac-option${picked ? " picked" : ""}`}>
              {badge.trophy ? (
                <span className="adm-ac-trophy" title="Win">
                  🏆
                </span>
              ) : (
                <span className="adm-ac-rank">{badge.rank}</span>
              )}
              <div className="adm-grow">
                <div>{m.label}</div>
                <div className="hint">
                  {m.meta}
                  {picked ? " · currently showing" : ""}
                </div>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() => void act(() => adminApi(`${base}/lock-accolade`, { method: "POST", body: m.kind === "link" ? { link_id: m.id } : { entry_id: m.id } }), "Accolade locked.")}
              >
                Lock this
              </button>
            </div>
          );
        })}
        <div className="adm-row">
          <button type="button" className="secondary" disabled={!accoladeLocked} onClick={() => void act(() => adminApi(`${base}/lock-accolade`, { method: "DELETE" }), "Back to automatic.")}>
            Back to auto
          </button>
        </div>
      </section>

      <section className="adm-card">
        <h2 className="adm-card-title">
          Trivia <Pill on={curated} onText="Curated" />
        </h2>
        {curated ? (
          <>
            <h3 className="adm-section">Curated list</h3>
            {d.triviaSelections.map((t, i) => (
              <div key={t.id} className="adm-ac-option">
                <div className="adm-grow">
                  {editing?.id === t.id ? (
                    <RichText value={editing.text} onChange={(text) => setEditing({ id: t.id, text })} placeholder="The fact…" />
                  ) : (
                    <div>{t.text}</div>
                  )}
                  <div className="hint">{t.sourceLabel}</div>
                </div>
                <div className="adm-ac-acts">
                  <button type="button" className="secondary" title="Move up" disabled={i === 0} onClick={() => void act(() => adminApi(`${base}/trivia/${encodeURIComponent(t.id)}/move`, { method: "POST", body: { direction: "up" } }))}>
                    ↑
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    title="Move down"
                    disabled={i === d.triviaSelections.length - 1}
                    onClick={() => void act(() => adminApi(`${base}/trivia/${encodeURIComponent(t.id)}/move`, { method: "POST", body: { direction: "down" } }))}
                  >
                    ↓
                  </button>
                  {t.custom ? (
                    editing?.id === t.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          if (!editing.text.trim()) return;
                          const text = editing.text.trim();
                          setEditing(null);
                          void act(() => adminApi(`${base}/trivia/${encodeURIComponent(t.id)}`, { method: "PATCH", body: { text } }), "Saved.");
                        }}
                      >
                        Save
                      </button>
                    ) : (
                      <button type="button" className="secondary" onClick={() => setEditing({ id: t.id, text: t.text })}>
                        Edit
                      </button>
                    )
                  ) : null}
                  <button type="button" className="secondary" onClick={() => void act(() => adminApi(`${base}/trivia/${encodeURIComponent(t.id)}`, { method: "DELETE" }))}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </>
        ) : null}
        <h3 className="adm-section">Candidates found</h3>
        {!trivia.shown.length ? <p className="hint">{d.triviaCandidates.length ? "Every one found is in the list above." : "None yet."}</p> : null}
        {trivia.shown.map((t) => (
          <div key={t.id} className="adm-ac-option">
            <div className="adm-grow">
              <div>{t.fact_text}</div>
              <div className="hint">{t.article_title}</div>
            </div>
            <button type="button" className="secondary" onClick={() => void act(() => adminApi(`${base}/trivia`, { method: "POST", body: { candidate_id: t.id } }), "Added.")}>
              Use this
            </button>
          </div>
        ))}
        {trivia.hidden ? (
          <button type="button" className="secondary" onClick={() => setAllTrivia(true)}>
            Show the other {trivia.hidden}
          </button>
        ) : null}
        <label className="adm-ac-label">Add your own</label>
        <RichText value={fact} onChange={setFact} placeholder="Type a trivia fact…" />
        <div className="adm-row">
          <button
            type="button"
            onClick={() => {
              if (!fact.trim()) return show("err", "Type a fact first.");
              const text = fact.trim();
              void act(() => adminApi(`${base}/trivia`, { method: "POST", body: { text } }), "Added.").then(() => setFact(""));
            }}
          >
            Add fact
          </button>
        </div>
      </section>
    </div>
  );
}

function Pill({ on, onText }: { on: boolean; onText: string }) {
  return <span className={`adm-ac-pill${on ? " on" : ""}`}>{on ? onText : "Auto"}</span>;
}
