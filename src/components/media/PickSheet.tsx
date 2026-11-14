"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTvBack } from "@/components/tv/TvProvider";
import { useCloseOnBack } from "@/lib/overlay-back";
import { findNextFocusable, type Direction } from "@/lib/tv/spatial-nav";

interface Pick {
  id: string;
  title: string;
  year: number | null;
  href: string;
  poster: string | null;
  reason: string;
  isGroup: boolean;
  runtimeMinutes: number | null;
}

interface PickResponse {
  picks: Pick[];
  mode: Mode;
  coldStart: boolean;
  poolSize: number;
}

type Mode = "new" | "finish" | "again" | "random";

const MODE_LABELS: Array<[Mode, string]> = [
  ["new", "Something new"],
  ["finish", "Finish something"],
  ["again", "Watch it again"],
  ["random", "Pure random"],
];

const ARROWS: Record<string, Direction> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

/** After this many re-rolls, offer the way out. Paralysis is the enemy here. */
const REROLL_LIMIT = 5;

/**
 * "Choose something for me".
 *
 * The slate arrives ten at a time and re-rolling walks it locally, so pressing
 * again is instant and never touches the network until the slate runs out.
 *
 * What has been offered lives in sessionStorage and nowhere else. That is a
 * deliberate privacy choice, not an oversight: a server-side offer log would
 * be the persistent per-person viewing record that the metrics feature was
 * parked over. The cost is that re-rolls do not follow you between devices,
 * which nobody will ever notice.
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

  const seen = useCallback((): string[] => {
    try {
      return JSON.parse(sessionStorage.getItem("pick-offered") ?? "[]") as string[];
    } catch {
      return [];
    }
  }, []);

  const remember = useCallback((ids: string[]) => {
    try {
      const merged = Array.from(new Set([...JSON.parse(sessionStorage.getItem("pick-offered") ?? "[]"), ...ids]));
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
  // TvProvider's Back stack. Without these, Back went to the previous page
  // with the sheet still open.
  useCloseOnBack(true, onClose);
  useTvBack(() => {
    onClose();
    return true;
  });

  // Drawn on <body>: inside the page, a transformed ancestor (a TV row) made
  // "position: fixed" relative to it, so the sheet sat over one row and the
  // page behind it was not dimmed.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = slate[index];

  // Focus goes into the sheet as it opens and onto Play/Open with the first
  // pick, so OK on the remote acts on it. After that it stays where the
  // viewer put it ("Something else" pressed again and again), and is only
  // brought back when it fell out of the sheet (a reload removed the button
  // it was on). Left on the opener, the remote drove the page behind.
  const firstPickFocused = useRef(false);
  useEffect(() => {
    if (!mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const inside = dialog.contains(document.activeElement);
    if (state === "idle" && current && !firstPickFocused.current) {
      firstPickFocused.current = true;
      dialog.querySelector<HTMLElement>(".pick-actions .btn")?.focus();
      return;
    }
    if (inside) return;
    const again = state === "idle" ? dialog.querySelector<HTMLElement>(".pick-actions .btn.ghost") : null;
    (again ?? dialog.querySelector<HTMLElement>("button"))?.focus();
  }, [mounted, state, current]);

  /** The arrows move between the sheet's own buttons and never reach the page behind it. */
  function onDialogKeyDown(event: React.KeyboardEvent) {
    const direction = ARROWS[event.key];
    if (!direction || !dialogRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !dialogRef.current.contains(active)) {
      dialogRef.current.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    findNextFocusable(active, direction, dialogRef.current)?.focus();
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
    setMode(next);
    setRerolls(0);
    void load(next, maxMinutes);
  }

  function chooseRuntime(next: number | null) {
    setMaxMinutes(next);
    setRerolls(0);
    void load(mode, next);
  }

  if (!mounted) return null;

  return createPortal(
    <div className="pick-backdrop" role="presentation" onClick={onClose}>
      <div
        className="pick-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Choose something for me"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onDialogKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pick-modes">
          {MODE_LABELS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={value === mode ? "pick-chip on" : "pick-chip"}
              onClick={() => chooseMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="pick-modes">
          {([[null, "Any length"], [90, "Under 90m"], [120, "Under 2h"]] as Array<[number | null, string]>).map(
            ([value, label]) => (
              <button
                key={label}
                type="button"
                className={value === maxMinutes ? "pick-chip on" : "pick-chip"}
                onClick={() => chooseRuntime(value)}
              >
                {label}
              </button>
            ),
          )}
        </div>

        {state === "loading" ? <p className="pick-status">Looking…</p> : null}

        {state === "error" ? (
          <p className="pick-status">
            That did not work. <button type="button" className="linkish" onClick={() => load(mode, maxMinutes)}>Try again</button>
          </p>
        ) : null}

        {state === "empty" ? (
          <div className="pick-status">
            <p>Nothing left that matches this.</p>
            <button type="button" className="linkish" onClick={() => chooseRuntime(null)}>
              Loosen the filters
            </button>
          </div>
        ) : null}

        {state === "idle" && current ? (
          <>
            <div className="pick-result">
              {current.poster ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={current.poster} alt="" className="pick-poster" loading="lazy" decoding="async" />
              ) : (
                <div className="pick-poster pick-poster-empty">{current.title}</div>
              )}
              <div className="pick-meta">
                <h2>{current.title}</h2>
                <p className="pick-sub">
                  {[current.year, current.runtimeMinutes ? `${current.runtimeMinutes}m` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="pick-reason">{current.reason}</p>
              </div>
            </div>

            <div className="pick-actions">
              <Link className="btn" href={current.href} onClick={onClose}>
                {current.isGroup ? "Open" : "Play"}
              </Link>
              <button type="button" className="btn ghost" onClick={reroll}>
                Something else
              </button>
            </div>

            {coldStart ? (
              <p className="pick-note">
                Nothing watched yet, so these lean on what he has written about.
              </p>
            ) : null}

            {rerolls >= REROLL_LIMIT ? (
              <p className="pick-note">
                Still nothing? <Link href="/browse" onClick={onClose}>Just show me the shelf.</Link>
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
