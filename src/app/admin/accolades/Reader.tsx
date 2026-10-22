"use client";

import { useEffect, useRef, useState } from "react";

import { adminApi } from "@/lib/admin/client-api";
import { paragraphs } from "@/lib/admin/accolades-view";

import { useToasts } from "../Toasts";
import { LibrarySearch } from "./LibrarySearch";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Article {
  id: string;
  title: string;
  source_id: string;
  url: string | null;
  fetched_at: number | string;
  full_text: string | null;
}

interface Link {
  id: string;
  raw_title: string;
  raw_year: number | null;
  imdb_id: string | null;
  confidence: string | null;
}

/**
 * One article's full text. Select a passage and add it to a blurb or to
 * trivia for the film chosen in Films; every film the article mentions is
 * listed above it to confirm, link or discard.
 */
export function Reader({
  articleId,
  film,
  onClose,
  onSaved,
}: {
  articleId: string;
  film: { imdbId: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { show } = useToasts();
  const [data, setData] = useState<{ article: Article; links: Link[] } | null>(null);
  const [blurb, setBlurb] = useState<string[]>([]);
  const [trivia, setTrivia] = useState<string[]>([]);
  const [pending, setPending] = useState<{ text: string; top: number; left: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      setData(await adminApi<{ article: Article; links: Link[] }>(`/api/admin/accolades/article/${encodeURIComponent(articleId)}`));
    } catch (e) {
      show("err", message(e));
    }
  };

  useEffect(() => {
    setData(null);
    setBlurb([]);
    setTrivia([]);
    setPending(null);
    void load();
    rootRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId]);

  useEffect(() => {
    const hide = () => setPending(null);
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, []);

  const onMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return setPending(null);
    const range = sel.getRangeAt(0);
    if (!bodyRef.current?.contains(range.commonAncestorContainer)) return setPending(null);
    const text = sel.toString().trim();
    if (!text) return setPending(null);
    const rect = range.getBoundingClientRect();
    setPending({ text, top: Math.max(8, rect.top - 44), left: Math.max(8, rect.left) });
  };

  const add = (kind: "blurb" | "trivia") => {
    if (!pending) return;
    (kind === "blurb" ? setBlurb : setTrivia)((list) => [...list, pending.text]);
    setPending(null);
    window.getSelection()?.removeAllRanges();
  };

  const filmPath = film ? `/api/admin/accolades/film/${encodeURIComponent(film.imdbId)}` : "";

  const saveBlurb = async () => {
    if (!film) return show("err", "Select a film in Films first.");
    if (!blurb.length) return show("err", "Select at least one passage first.");
    try {
      await adminApi(`${filmPath}/lock-blurb`, {
        method: "POST",
        body: { text: blurb.join(" … "), source_label: data?.article.source_id, source_url: data?.article.url ?? undefined },
      });
      show("ok", `Blurb locked for ${film.name}.`);
      onSaved();
      onClose();
    } catch (e) {
      show("err", message(e));
    }
  };

  const saveTrivia = async () => {
    if (!film) return show("err", "Select a film in Films first.");
    if (!trivia.length) return show("err", "Select at least one passage first.");
    try {
      for (const text of trivia) await adminApi(`${filmPath}/trivia`, { method: "POST", body: { text } });
      show("ok", `Trivia facts saved for ${film.name}.`);
      onSaved();
      onClose();
    } catch (e) {
      show("err", message(e));
    }
  };

  const unlink = async (linkId: string) => {
    try {
      await adminApi(`/api/admin/accolades/article/${encodeURIComponent(articleId)}/links/${encodeURIComponent(linkId)}`, { method: "DELETE" });
      show("ok", "Removed.");
      await load();
      onSaved();
    } catch (e) {
      show("err", message(e));
    }
  };

  const link = async (linkId: string, imdbId: string) => {
    try {
      await adminApi(`/api/admin/accolades/article/${encodeURIComponent(articleId)}/links/${encodeURIComponent(linkId)}`, { method: "POST", body: { imdb_id: imdbId } });
      show("ok", "Linked.");
      await load();
      onSaved();
    } catch (e) {
      show("err", message(e));
    }
  };

  if (!data) return <div ref={rootRef} className="adm-ac-reader"><p className="hint">Loading…</p></div>;
  const a = data.article;

  return (
    <div ref={rootRef} className="adm-ac-reader">
      <div className="adm-row">
        <div className="adm-grow">
          <h3 className="adm-card-title">{a.title}</h3>
          <div className="hint">
            {a.source_id} — fetched {new Date(a.fetched_at).toLocaleDateString()}
            {a.url ? (
              <>
                {" · "}
                <a href={a.url} target="_blank" rel="noreferrer">
                  original
                </a>
              </>
            ) : null}
          </div>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          ✕ Close
        </button>
      </div>

      {data.links.length ? (
        <div className="adm-ac-matches">
          <strong>Films this mentions ({data.links.length})</strong>
          {data.links.map((l) => (
            <div key={l.id} className="adm-ac-match">
              <div className="adm-grow">
                <div>
                  {l.raw_title}
                  {l.raw_year ? ` (${l.raw_year})` : ""}
                </div>
                {l.imdb_id ? (
                  <div className="adm-ac-ok">Matched — {l.confidence}</div>
                ) : (
                  <>
                    <div className="hint">Not matched yet</div>
                    <LibrarySearch placeholder="Search your library to link this…" onPick={(r) => void link(l.id, r.imdbId)} />
                  </>
                )}
              </div>
              <button type="button" className="secondary" onClick={() => void unlink(l.id)}>
                {l.imdb_id ? "Unlink" : "Discard"}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="adm-ac-collect">
        <div className="hint">
          {film ? (
            <>
              Collecting for <b>{film.name}</b>. Select text below, then add it to the blurb or to trivia.
            </>
          ) : (
            "Select a film in Films to collect passages for it."
          )}
        </div>
        <Collected title="Your blurb" lines={blurb} quote onRemove={(i) => setBlurb(blurb.filter((_, j) => j !== i))} />
        <Collected title="Your trivia facts" lines={trivia} onRemove={(i) => setTrivia(trivia.filter((_, j) => j !== i))} />
      </div>

      <div ref={bodyRef} className="adm-ac-body" onMouseUp={onMouseUp}>
        {paragraphs(a.full_text).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <div className="adm-row adm-ac-foot">
        <button type="button" disabled={!film || !blurb.length} onClick={() => void saveBlurb()}>
          Lock this blurb
        </button>
        <button type="button" className="secondary" disabled={!film || !trivia.length} onClick={() => void saveTrivia()}>
          Save trivia facts
        </button>
      </div>

      {pending ? (
        <div className="adm-ac-seltools" style={{ top: pending.top, left: pending.left }} onMouseDown={(e) => e.preventDefault()}>
          <button type="button" onClick={() => add("blurb")}>
            Add to blurb
          </button>
          <button type="button" onClick={() => add("trivia")}>
            Add to trivia
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Collected({ title, lines, quote, onRemove }: { title: string; lines: string[]; quote?: boolean; onRemove: (i: number) => void }) {
  return (
    <div className="adm-ac-collected">
      <div className="adm-ac-collected-head">{title}</div>
      {lines.length ? (
        lines.map((t, i) => (
          <div key={i} className="adm-row">
            <div className="adm-grow">{quote ? `${i + 1}. "${t}"` : t}</div>
            <button type="button" className="secondary adm-x" title="Remove" onClick={() => onRemove(i)}>
              ✕
            </button>
          </div>
        ))
      ) : (
        <div className="hint">Nothing selected yet.</div>
      )}
    </div>
  );
}
