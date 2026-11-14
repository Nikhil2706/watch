"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTvBack, useTvMode } from "@/components/tv/TvProvider";
import { useCloseOnBack } from "@/lib/overlay-back";
import { findNextFocusable, type Direction } from "@/lib/tv/spatial-nav";

interface Pick {
  id: string;
  title: string;
  year: number | null;
  href: string;
  playHref: string | null;
  poster: string | null;
  reason: string;
  isGroup: boolean;
  runtimeMinutes: number | null;
  directors: string[];
  genres: string[];
  overview: string | null;
}

interface PickResponse {
  picks: Pick[];
  mode: Mode;
  coldStart: boolean;
  poolSize: number;
}

type Mode = "new" | "finish" | "again" | "random";

const MODES: Array<[Mode, string]> = [
  ["new", "Something new"],
  ["finish", "Finish something"],
  ["again", "Watch again"],
  ["random", "Anything"],
];

const LENGTHS: Array<[number | null, string]> = [
  [null, "Any length"],
  [90, "Under 90 min"],
  [120, "Under 2 hours"],
];

const ARROWS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** After this many re-rolls, offer the way out. Paralysis is the enemy here. */
const REROLL_LIMIT = 5;

function runtimeLabel(minutes: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * "Choose something for me".
 *
 * Laid out top to bottom in the order a person decides: what kind of thing,
 * how long, then the pick itself (what it is, why it was picked, what it is
 * about), then what to do with it. Each filter is a labelled group of options
 * (a radio group to a screen reader) whose chosen option is filled and ticked,
 * not just outlined. The pick sits in a live region, so a new one is read out.
 * Play starts a film straight away; "More about it" opens its page.
 *
 * The slate arrives ten at a time and re-rolling walks it locally, so pressing
 * again is instant and never touches the network until the slate runs out.
 *
 * What has been offered lives in sessionStorage and nowhere else. That is a
 * deliberate privacy choice, not an oversight: a server-side offer log would
 * be the persistent per-person viewing record that the metrics feature was
 * parked over.
 */
export function PickSheet({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("new");
  const [maxMinutes, setMaxMinutes] = useState<number | null>(null);
  const [slate, setSlate] = useState<Pick[]>([]);
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "error" | "empty">("loading");
  const [coldStart, setColdStart] = useState(false);
  const [rerolls, setRerolls] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const tvMode = useTvMode();
  const ids = useId();
  const titleId = `${ids}-title`;
  const moodId = `${ids}-mood`;
  const lengthId = `${ids}-length`;

  const seen = useCallback((): string[] => {
    try {
      return JSON.parse(sessionStorage.getItem("pick-offered") ?? "[]") as string[];
    } catch {
      return [];
    }
  }, []);

  const remember = useCallback((list: string[]) => {
    try {
      const merged = Array.from(new Set([...JSON.parse(sessionStorage.getItem("pick-offered") ?? "[]"), ...list]));
      sessionStorage.setItem("pick-offered", JSON.stringify(merged.slice(-200)));
    } catch {
      // A private window with storage disabled just means re-rolls repeat
      // sooner. Not worth failing the feature over.
    }
  }, []);

  const load = useCallback(
    async (nextMode: Mode, minutes: number | null) => {
      setState("loading");
      const params = new URLSearchParams({ mode: nextMode, seed: String(Date.now()) });
      if (minutes) params.set("maxMinutes", String(minutes));
      const exclude = seen();
      if (exclude.length > 0) params.set("exclude", exclude.join(","));

      try {
        const res = await fetch(`/api/pick?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PickResponse;
        setColdStart(data.coldStart);
        setSlate(data.picks);
        setIndex(0);
        if (data.picks.length === 0) {
          setState("empty");
          return;
        }
        remember(data.picks.map((p) => p.id));
        setState("idle");
      } catch {
        setState("error");
      }
    },
    [remember, seen],
  );

  useEffect(() => {
    void load(mode, maxMinutes);
    // Deliberately only on mount — mode and runtime changes call load() themselves,
    // so that a re-render does not silently re-roll the pick out from under someone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The TV remote's Back closes the sheet rather than leaving the page: the
  // Android app asks overlay-back first, a TV browser sends Escape to
  // TvProvider's Back stack.
  useCloseOnBack(true, onClose);
  useTvBack(() => {
    onClose();
    return true;
  });

  // Drawn on <body>: inside the page, a transformed ancestor (a TV row) made
  // "position: fixed" relative to it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Nothing behind the sheet scrolls while it is open.
  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = before;
    };
  }, []);

  const current = slate[index];

  // Focus goes into the sheet as it opens and onto Play/Open with the first
  // pick, so OK on the remote (or Enter) acts on it. After that it stays where
  // the viewer put it ("Something else" pressed again and again), and is only
  // brought back when it fell out of the sheet.
  const firstPickFocused = useRef(false);
  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const inside = dialog.contains(document.activeElement);
    if (state === "idle" && current && !firstPickFocused.current) {
      firstPickFocused.current = true;
      dialog.querySelector<HTMLElement>("[data-pick-primary]")?.focus();
      return;
    }
    if (inside) return;
    const again = state === "idle" ? dialog.querySelector<HTMLElement>("[data-pick-again]") : null;
    (again ?? dialog.querySelector<HTMLElement>("[role=radio][aria-checked=true]"))?.focus();
  }, [mounted, state, current]);

  /**
   * The arrows move between the sheet's own controls and never reach the page
   * behind it. Tab is kept inside too, wrapping at either end.
   */
  function onDialogKeyDown(event: React.KeyboardEvent) {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (event.key === "Tab") {
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    const direction = ARROWS[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !dialog.contains(active)) {
      dialog.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    findNextFocusable(active, direction, dialog)?.focus();
  }

  function reroll() {
    setRerolls((n) => n + 1);
    if (index + 1 < slate.length) {
      setIndex(index + 1);
    } else {
      void load(mode, maxMinutes);
    }
  }

  function chooseMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setRerolls(0);
    void load(next, maxMinutes);
  }

  function chooseLength(next: number | null) {
    if (next === maxMinutes) return;
    setMaxMinutes(next);
    setRerolls(0);
    void load(mode, next);
  }

  if (!mounted) return null;

  const facts = current
    ? [current.year, runtimeLabel(current.runtimeMinutes), current.genres.join(", ") || null].filter(Boolean)
    : [];

  return createPortal(
    <div className="pick-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pick-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onDialogKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pick-head">
          <h2 id={titleId}>Choose something for me</h2>
          <button type="button" className="pick-close" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="pick-filters">
          <div className="pick-filter">
            <p className="pick-filter-label" id={moodId}>
              In the mood for
            </p>
            <div className="pick-options" role="radiogroup" aria-labelledby={moodId}>
              {MODES.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={value === mode}
                  className="pick-option"
                  onClick={() => chooseMode(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="pick-filter">
            <p className="pick-filter-label" id={lengthId}>
              How long have you got?
            </p>
            <div className="pick-options" role="radiogroup" aria-labelledby={lengthId}>
              {LENGTHS.map(([value, label]) => (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={value === maxMinutes}
                  className="pick-option"
                  onClick={() => chooseLength(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* The pick, read out when it changes. Kept the same height while
            loading so the buttons below do not jump under a pointer. */}
        <section className="pick-card" aria-live="polite" aria-busy={state === "loading"}>
          {state === "loading" ? (
            <div className="pick-card-body">
              <div className="pick-poster pick-poster-empty" aria-hidden="true" />
              <p className="pick-status">Finding something…</p>
            </div>
          ) : null}

          {state === "error" ? (
            <div className="pick-card-body pick-card-message">
              <p className="pick-status">That didn&rsquo;t work.</p>
              <button type="button" className="btn ghost" onClick={() => load(mode, maxMinutes)}>
                Try again
              </button>
            </div>
          ) : null}

          {state === "empty" ? (
            <div className="pick-card-body pick-card-message">
              <p className="pick-status">Nothing left that matches.</p>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setMaxMinutes(null);
                  setMode("random");
                  setRerolls(0);
                  void load("random", null);
                }}
              >
                Show me anything
              </button>
            </div>
          ) : null}

          {state === "idle" && current ? (
            <div className="pick-card-body">
              {current.poster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={current.poster} alt="" className="pick-poster" decoding="async" />
              ) : (
                <div className="pick-poster pick-poster-empty" aria-hidden="true">
                  {current.title}
                </div>
              )}
              <div className="pick-meta">
                <h3 className="pick-title">{current.title}</h3>
                {facts.length > 0 ? <p className="pick-facts">{facts.join(" · ")}</p> : null}
                {current.directors.length > 0 ? (
                  <p className="pick-facts">Directed by {current.directors.join(" and ")}</p>
                ) : null}
                <p className="pick-why">
                  <span className="pick-why-label">Why this: </span>
                  {current.reason}
                </p>
                {current.overview ? <p className="pick-overview">{current.overview}</p> : null}
              </div>
            </div>
          ) : null}
        </section>

        {state === "idle" && current ? (
          <div className="pick-actions">
            <Link className="btn" href={current.playHref ?? current.href} onClick={onClose} data-pick-primary="">
              {current.playHref ? "▶ Play" : "Open"}
            </Link>
            <button type="button" className="btn ghost" onClick={reroll} data-pick-again="">
              ↻ Something else
            </button>
            {current.playHref ? (
              <Link className="btn ghost" href={current.href} onClick={onClose}>
                More about it
              </Link>
            ) : null}
          </div>
        ) : null}

        {coldStart && state === "idle" ? (
          <p className="pick-note">You haven&rsquo;t watched anything yet, so these lean on what critics rate highly.</p>
        ) : null}

        {rerolls >= REROLL_LIMIT && state === "idle" ? (
          <p className="pick-note">
            Still nothing?{" "}
            <Link href="/browse" onClick={onClose}>
              Browse the whole library
            </Link>
            .
          </p>
        ) : null}

        <p className="pick-hint" aria-hidden="true">
          {tvMode ? "Back to close" : "Esc to close"}
        </p>
      </div>
    </div>,
    document.body,
  );
}
