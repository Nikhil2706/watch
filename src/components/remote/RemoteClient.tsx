"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { itemHref } from "@/lib/slugs";

import { InstallNudge } from "./InstallNudge";

/**
 * The phone half of the remote: pair with a screen, see what it is playing,
 * drive it, and search the library with a real keyboard instead of a D-pad.
 *
 * State comes from polling /api/remote/control rather than a second SSE
 * stream — see that route's comment. Commands go out as plain POSTs.
 */

const PAIRED_KEY = "jfg.remote.screenId";
/** Written by ScreenAgent. If this browser has ever been a screen, it must not offer to control itself. */
const OWN_SCREEN_KEY = "jfg.screenId";
const POLL_MS = 3000;

interface ScreenState {
  href: string;
  title: string | null;
  posterUrl: string | null;
  positionSeconds: number | null;
  durationSeconds: number | null;
  paused: boolean;
  playing: boolean;
}

interface Screen {
  id: string;
  name: string;
  /** True only when the screen has a live command stream — see remote-bus.ts. */
  online: boolean;
  lastSeenAgoMs: number;
  state: ScreenState;
}

interface SearchHit {
  id: string;
  name: string;
  year: number | null;
  poster: string | null;
  reason?: string;
  href?: string;
}

function formatTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function RemoteClient() {
  const [screens, setScreens] = useState<Screen[]>([]);
  const [screenId, setScreenId] = useState<string | null>(null);
  const [ownScreenId, setOwnScreenId] = useState<string | null>(null);
  const [showPairForm, setShowPairForm] = useState(false);
  const [code, setCode] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Screens this phone could sensibly drive.
   *
   * Excludes itself: ScreenAgent registers any browser that has ever been used
   * as a screen, and the id it stores is shared across tabs — so without this
   * filter a phone that once opened /screen appears in its own remote's list,
   * as an entry indistinguishable from the real television.
   */
  const controllable = screens.filter((s) => s.id !== ownScreenId);
  const online = controllable.filter((s) => s.online);
  const screen = controllable.find((s) => s.id === screenId) ?? null;

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  }, []);

  useEffect(() => {
    setScreenId(localStorage.getItem(PAIRED_KEY));
    setOwnScreenId(localStorage.getItem(OWN_SCREEN_KEY));
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/control", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { screens: Screen[] };
      setScreens(data.screens);
      // Auto-select when there is exactly one screen and nothing chosen yet -
      // the common case is a household with one television, and making that
      // person type a code to reach it would be ceremony for its own sake.
      const own = localStorage.getItem(OWN_SCREEN_KEY);
      const usable = data.screens.filter((s) => s.id !== own);
      const live = usable.filter((s) => s.online);

      setScreenId((current) => {
        if (current && usable.some((s) => s.id === current)) return current;
        // Auto-select ONLY when there is exactly one screen actually
        // listening — that is unambiguous and saves a pointless code entry.
        // With two or more, guessing is worse than asking: the previous
        // version silently picked one, which is why a phone could land on a
        // dropdown of identical entries having never been offered a code.
        if (live.length === 1) {
          localStorage.setItem(PAIRED_KEY, live[0]!.id);
          return live[0]!.id;
        }
        return null;
      });
    } catch {
      /* offline; next tick retries */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const send = useCallback(
    async (body: Record<string, unknown>) => {
      if (!screenId) return;
      try {
        const response = await fetch("/api/remote/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "command", screenId, ...body }),
        });
        if (response.status === 409) {
          flash("That screen isn't connected right now.");
          return;
        }
        if (!response.ok) {
          flash("Couldn't reach the screen.");
          return;
        }
        // Pull fresh state straight away so the UI does not lag a poll behind.
        void load();
      } catch {
        flash("Couldn't reach the screen.");
      }
    },
    [screenId, flash, load],
  );

  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setPairError(null);
    try {
      const response = await fetch("/api/remote/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pair", code }),
      });
      const data = (await response.json()) as { screen?: Screen; message?: string };
      if (!response.ok || !data.screen) {
        setPairError(data.message ?? "That code didn't match a screen.");
        return;
      }
      localStorage.setItem(PAIRED_KEY, data.screen.id);
      setScreenId(data.screen.id);
      setCode("");
      void load();
    } catch {
      setPairError("No connection.");
    }
  }

  // Type-ahead against the same endpoint the site's own search box uses.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setHits([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/suggest?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { results: SearchHit[] };
          setHits(data.results);
        }
      } catch {
        /* ignore */
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const progress =
    screen?.state.durationSeconds && screen.state.positionSeconds != null
      ? Math.min(100, (screen.state.positionSeconds / screen.state.durationSeconds) * 100)
      : 0;

  return (
    <div className="remote">
      <header className="remote-head">
        <h1>Remote</h1>
        {screen && controllable.length > 1 ? (
          <select
            className="remote-screen-select"
            value={screenId ?? ""}
            onChange={(e) => {
              localStorage.setItem(PAIRED_KEY, e.target.value);
              setScreenId(e.target.value);
            }}
            aria-label="Which screen to control"
          >
            {controllable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.online ? "" : " (offline)"}
              </option>
            ))}
          </select>
        ) : screen ? (
          <span className={`remote-status${screen.online ? " online" : ""}`}>
            {screen.name} · {screen.online ? "connected" : "not listening"}
          </span>
        ) : null}
      </header>

      {screen && !screen.online ? (
        <p className="remote-offline" role="status">
          <strong>{screen.name} isn’t listening for commands.</strong> Open the site on that screen
          again — if it’s already open, reload the page there. It reconnects on its own within a few
          seconds.
        </p>
      ) : null}

      {notice ? (
        <p className="remote-notice" role="status">
          {notice}
        </p>
      ) : null}

      {!screen ? (
        <section className="remote-pair">
          <h2>Connect to your TV</h2>

          {/* When several screens are listening, naming them is the honest
              way to choose — a code is only needed for one this phone has
              never seen. */}
          {online.length > 0 ? (
            <>
              <p className="remote-hint">Screens signed in to your account and listening now:</p>
              <ul className="remote-screen-list">
                {online.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        localStorage.setItem(PAIRED_KEY, s.id);
                        setScreenId(s.id);
                      }}
                    >
                      <span className="remote-screen-name">{s.name}</span>
                      <span className="remote-screen-where">
                        {s.state.title ?? "Idle"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {/* type="button" matters: a bare <button> defaults to submit,
                  and this sits a few lines above a form. */}
              <button type="button" className="remote-link-btn" onClick={() => setShowPairForm((v) => !v)}>
                {showPairForm ? "Hide code entry" : "Not listed? Enter a code instead"}
              </button>
            </>
          ) : null}

          {/* Shown outright when nothing is listening, and behind a toggle
              when something is — so the code path is always reachable rather
              than hidden by an auto-selection the user never asked for. */}
          {online.length === 0 || showPairForm ? (
            <>
              <p className="remote-hint">
                On the television, open{" "}
                <strong>{typeof window === "undefined" ? "" : window.location.host}/screen</strong> — it will
                show a six-character code. Both devices need to be signed in to the same account.
              </p>
              <form onSubmit={pair}>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="Code from the TV"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={6}
                  className="remote-code-input"
                  aria-label="Pairing code shown on the television"
                />
                <button type="submit" className="remote-primary">
                  Connect
                </button>
              </form>
              {pairError ? (
                <p className="error" role="alert">
                  {pairError}
                </p>
              ) : null}
            </>
          ) : null}

          {controllable.length > online.length ? (
            <p className="remote-hint remote-stale-note">
              {controllable.length - online.length} other screen
              {controllable.length - online.length === 1 ? "" : "s"} on your account{" "}
              {controllable.length - online.length === 1 ? "is" : "are"} signed in but not listening.
              They’ll appear here once the site is open on them.
            </p>
          ) : null}
        </section>
      ) : (
        <>
          <section className="remote-now">
            <div className="remote-art">
              {screen.state.posterUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={screen.state.posterUrl} alt="" />
              ) : (
                <div className="remote-art-empty" aria-hidden="true" />
              )}
            </div>
            <div className="remote-meta">
              <p className="remote-title">{screen.state.title ?? "Nothing playing"}</p>
              <p className="remote-sub">{screen.state.playing ? (screen.state.paused ? "Paused" : "Playing") : "Browsing"}</p>
              {screen.state.playing ? (
                <>
                  <div className="remote-bar" aria-hidden="true">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <p className="remote-times">
                    {formatTime(screen.state.positionSeconds)} / {formatTime(screen.state.durationSeconds)}
                  </p>
                </>
              ) : null}
            </div>
          </section>

          <section className="remote-transport" aria-label="Playback controls">
            <button type="button" onClick={() => void send({ type: "seekBy", deltaSeconds: -30 })} aria-label="Back 30 seconds">
              −30
            </button>
            <button type="button" onClick={() => void send({ type: "seekBy", deltaSeconds: -10 })} aria-label="Back 10 seconds">
              −10
            </button>
            <button
              type="button"
              className="remote-playpause"
              onClick={() => void send({ type: "playPause" })}
              aria-label={screen.state.paused ? "Play" : "Pause"}
            >
              {screen.state.paused ? "▶" : "❚❚"}
            </button>
            <button type="button" onClick={() => void send({ type: "seekBy", deltaSeconds: 10 })} aria-label="Forward 10 seconds">
              +10
            </button>
            <button type="button" onClick={() => void send({ type: "seekBy", deltaSeconds: 30 })} aria-label="Forward 30 seconds">
              +30
            </button>
          </section>

          <section className="remote-nav" aria-label="Navigation">
            <button type="button" onClick={() => void send({ type: "back" })}>Back</button>
            <button type="button" onClick={() => void send({ type: "navigate", href: "/browse" })}>Browse</button>
            <button type="button" onClick={() => void send({ type: "navigate", href: "/" })}>Home</button>
            <button type="button" onClick={() => void send({ type: "reload" })}>Reload</button>
          </section>

          <section className="remote-search" aria-label="Search the library">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search films and shows…"
              type="search"
              autoCorrect="off"
              aria-label="Search the library"
            />
            {searching && hits.length === 0 ? <p className="remote-hint">Searching…</p> : null}
            <ul className="remote-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => {
                      void send({ type: "navigate", href: hit.href ?? itemHref(hit.id, hit.name, hit.year) });
                      flash(`Opening ${hit.name} on the TV`);
                    }}
                  >
                    {hit.poster ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={hit.poster} alt="" loading="lazy" />
                    ) : (
                      <span className="remote-hit-blank" aria-hidden="true" />
                    )}
                    <span className="remote-hit-text">
                      <span className="remote-hit-name">
                        {hit.name}
                        {hit.year ? ` (${hit.year})` : ""}
                      </span>
                      {hit.reason ? <span className="remote-hit-reason">{hit.reason}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <InstallNudge />
    </div>
  );
}
