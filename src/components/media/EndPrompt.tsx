"use client";

import { useEffect, useRef, useState } from "react";

import { useTvMode } from "@/components/tv/TvProvider";
import { scoreToStars, starsToScore } from "@/lib/stars";
import { findNextFocusable } from "@/lib/tv/spatial-nav";

import { StarPicker } from "./StarPicker";

/** What the player needs to ask about a film when it ends (watch page, films only). */
export interface RatePrompt {
  imdbId: string;
  title: string;
  /** The film's own page, for "see what others said". */
  href: string;
  /** This viewer's rating already, on the DB's 1-10 scale. */
  yourScore: number | null;
  /** An SVG QR code of the film's page at #comment, for typing on a phone instead of a remote. */
  qrSvg: string | null;
}

const MAX_COMMENT_CHARS = 2000;

/**
 * "How was it?", over the black screen when a film ends: the same half-star
 * rating and comment the film's page has (POST /api/ratings, /api/comments),
 * without going there.
 *
 * On a TV it takes focus, and the remote moves inside it as on any page
 * (spatial-nav.ts): left/right along the stars, down to the buttons, OK to
 * press. The player hands it every key while focus is in it. Typing a comment
 * with a remote is miserable, so a TV also shows a QR code that opens the
 * film's comment box on a phone.
 */
export function EndPrompt({ prompt, onClose }: { prompt: RatePrompt; onClose: () => void }) {
  const tvMode = useTvMode();
  const [stars, setStars] = useState<number | null>(prompt.yourScore !== null ? scoreToStars(prompt.yourScore) : null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"asking" | "posting" | "done" | "error">("asking");
  const panel = useRef<HTMLDivElement>(null);

  // Focus on the stars (the ones already given, else the middle), so OK or a
  // click is all a rating takes.
  useEffect(() => {
    const hits = panel.current?.querySelectorAll<HTMLButtonElement>(".star-hit");
    if (!hits?.length) return;
    const index = stars !== null ? Math.max(0, Math.round(stars * 2) - 1) : 5;
    hits[Math.min(index, hits.length - 1)]?.focus();
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One post per press: on the Android TV app an OK can arrive as a keydown
  // and a click both (player-keys.ts, createOkPressGuard), and state set here
  // is not seen by the second until a render.
  const posting = useRef(false);

  async function post() {
    if (posting.current) return;
    posting.current = true;
    setState("posting");
    const send = (url: string, body: unknown) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      const results = await Promise.all([
        stars !== null && starsToScore(stars) !== prompt.yourScore
          ? send("/api/ratings", { imdbId: prompt.imdbId, score: starsToScore(stars) })
          : null,
        text.trim()
          ? send("/api/comments", { imdbId: prompt.imdbId, body: text.trim(), filmTitle: prompt.title, filmHref: prompt.href })
          : null,
      ]);
      setState(results.every((r) => r === null || r.ok) ? "done" : "error");
    } catch {
      setState("error");
    } finally {
      posting.current = false;
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const direction = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" } as const)[
      event.key as "ArrowLeft"
    ];
    if (!direction) return;
    // Left/right inside the comment box move its cursor.
    if (target.tagName === "TEXTAREA" && (direction === "left" || direction === "right")) return;
    event.preventDefault();
    event.stopPropagation();
    if (panel.current) findNextFocusable(target, direction, panel.current)?.focus();
  }

  const canPost = state !== "posting" && (text.trim() !== "" || (stars !== null && starsToScore(stars) !== prompt.yourScore));

  return (
    <div className="end-prompt" ref={panel} role="dialog" aria-label={`Rate ${prompt.title}`} onKeyDown={onKeyDown}>
      {state === "done" ? (
        <>
          <h2>Thanks.</h2>
          <p className="end-prompt-hint">
            <a href={`${prompt.href}#comment`}>See what everyone else thought ›</a>
          </p>
          <div className="end-prompt-actions">
            <button type="button" className="btn ghost" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <h2>How was {prompt.title}?</h2>
          <div className="end-prompt-body">
            <div className="end-prompt-main">
              <StarPicker value={stars} onRate={setStars} />
              <textarea
                className="composer-input"
                placeholder="Say what you thought (optional)…"
                value={text}
                maxLength={MAX_COMMENT_CHARS}
                rows={3}
                onChange={(e) => setText(e.target.value)}
              />
              {state === "error" ? <p className="end-prompt-error">That didn&apos;t save. Try again?</p> : null}
              <div className="end-prompt-actions">
                <button type="button" className="btn" disabled={!canPost} onClick={() => void post()}>
                  {state === "posting" ? "Posting…" : "Post"}
                </button>
                <button type="button" className="btn ghost" onClick={onClose}>
                  Not now
                </button>
              </div>
            </div>
            {tvMode && prompt.qrSvg ? (
              <figure className="end-prompt-qr">
                <div aria-hidden="true" dangerouslySetInnerHTML={{ __html: prompt.qrSvg }} />
                <figcaption>Comment from your phone</figcaption>
              </figure>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
