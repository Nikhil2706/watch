"use client";

import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

/**
 * The TV half of the phone-remote feature.
 *
 * Mounted once in the root layout. It registers this browser as a
 * controllable "screen", holds open an SSE command stream, executes whatever
 * the phone sends, and reports back what is on screen so the phone can render
 * a now-playing panel. See src/lib/remote-bus.ts for why SSE and not a
 * WebSocket.
 *
 * Deliberately drives playback through the DOM's own `<video>` element rather
 * than Player.tsx's Vidstack API. The player is a heavy client component
 * mounted only on item pages, and reaching into its internals from the layout
 * would couple this to its lifecycle for no benefit — every player it could
 * ever use still renders a plain `<video>`, and pause/seek on that element is
 * exactly what the remote needs.
 *
 * Only registers when this browser plausibly IS a television: TV mode is
 * active, `?screen=1` was passed once, or this browser has registered before
 * (a screenId in localStorage). Without that check every phone that opened the
 * site would appear in its own remote's screen list.
 */

const SCREEN_ID_KEY = "jfg.screenId";
const SCREEN_OPT_IN_KEY = "jfg.screenOptIn";
/** Slow enough not to be chatty, fast enough that a scrub bar on the phone tracks. */
const STATE_INTERVAL_MS = 4000;
const RECONNECT_DELAY_MS = 3000;

type Command =
  | { type: "navigate"; href: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "playPause" }
  | { type: "seekTo"; positionSeconds: number }
  | { type: "seekBy"; deltaSeconds: number }
  | { type: "back" }
  | { type: "reload" }
  | { type: "ping" };

function video(): HTMLVideoElement | null {
  return document.querySelector("video");
}

/**
 * A first guess at what this device is, so the phone's screen list reads
 * "Living room TV" / "Windows PC" rather than three entries all called
 * "Television". Only used on first registration; a rename from the phone
 * sticks and is never overwritten by this.
 */
function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/tizen/i.test(ua)) return "Samsung TV";
  if (/web0s|webos/i.test(ua)) return "LG TV";
  if (/android\s*tv|googletv/i.test(ua)) return "Android TV";
  if (/aft[bmnst]/i.test(ua)) return "Fire TV";
  if (/crkey/i.test(ua)) return "Chromecast";
  if (/appletv/i.test(ua)) return "Apple TV";
  if (/smart-?tv|hbbtv|viera|bravia|nettv/i.test(ua)) return "Smart TV";
  if (/ipad/i.test(ua)) return "iPad";
  if (/iphone/i.test(ua)) return "iPhone";
  if (/android/i.test(ua)) return "Android device";
  if (/mac os x/i.test(ua)) return "Mac";
  if (/windows/i.test(ua)) return "Windows PC";
  if (/linux/i.test(ua)) return "Linux PC";
  return "Screen";
}

function posterUrl(): string | null {
  const v = video();
  if (v?.poster) return v.poster;
  const og = document.querySelector<HTMLMetaElement>('meta[property="og:image"]');
  if (og?.content) return og.content;
  // Fall back to the largest poster image actually on the page - on an item
  // page that is the artwork, which is exactly what the phone wants to show.
  const img = document.querySelector<HTMLImageElement>(".poster-art img, .hero img, img");
  return img?.currentSrc || img?.src || null;
}

export function ScreenAgent({ tvMode }: { tvMode: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const screenIdRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  const sourceRef = useRef<EventSource | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportState = useCallback(async () => {
    const screenId = screenIdRef.current;
    if (!screenId) return;
    const v = video();
    try {
      const response = await fetch("/api/remote/screen", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          screenId,
          href: window.location.pathname + window.location.search,
          // document.title is "Film Name · Watch"-ish; the phone shows it as
          // given rather than this guessing at a parse.
          title: document.title,
          subtitle: null,
          itemId: null,
          posterUrl: posterUrl(),
          positionSeconds: v ? v.currentTime : null,
          durationSeconds: v && Number.isFinite(v.duration) ? v.duration : null,
          paused: v ? v.paused : true,
          playing: !!v,
        }),
      });
      // The gate restarted and forgot us - re-register so the phone's stored
      // screenId keeps working.
      if (response.status === 404) await register();
    } catch {
      /* offline; the next tick retries */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runCommand = useCallback(
    (command: Command) => {
      const v = video();
      switch (command.type) {
        case "navigate":
          router.push(command.href);
          break;
        case "back":
          window.history.back();
          break;
        case "reload":
          window.location.reload();
          break;
        case "play":
          void v?.play().catch(() => {});
          break;
        case "pause":
          v?.pause();
          break;
        case "playPause":
          if (!v) break;
          if (v.paused) void v.play().catch(() => {});
          else v.pause();
          break;
        case "seekTo":
          if (v) v.currentTime = command.positionSeconds;
          break;
        case "seekBy":
          if (v) v.currentTime = Math.max(0, v.currentTime + command.deltaSeconds);
          break;
        case "ping":
          break;
      }
      // Always answer with fresh state so the phone's UI reflects the result
      // immediately instead of waiting for the next poll.
      void reportState();
    },
    [router, reportState],
  );

  const connect = useCallback(() => {
    const screenId = screenIdRef.current;
    if (!screenId || sourceRef.current) return;

    const source = new EventSource(`/api/remote/events?screenId=${encodeURIComponent(screenId)}`);
    sourceRef.current = source;

    source.addEventListener("command", (event) => {
      try {
        runCommand(JSON.parse((event as MessageEvent).data) as Command);
      } catch {
        /* malformed frame; ignore */
      }
    });

    source.addEventListener("ready", () => {
      void reportState();
    });

    // The server closes the stream with this when it does not recognise the
    // screen - re-register rather than reconnecting into the same rejection.
    source.addEventListener("stale", () => {
      source.close();
      sourceRef.current = null;
      void register();
    });

    source.onerror = () => {
      source.close();
      sourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => connect(), RECONNECT_DELAY_MS);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runCommand, reportState]);

  const register = useCallback(async () => {
    try {
      const response = await fetch("/api/remote/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screenId: screenIdRef.current, name: guessDeviceName() }),
      });
      if (!response.ok) return; // not signed in yet, or transient
      const data = (await response.json()) as { screenId: string };
      screenIdRef.current = data.screenId;
      localStorage.setItem(SCREEN_ID_KEY, data.screenId);
      connect();
      void reportState();
    } catch {
      /* offline; a later navigation retries */
    }
  }, [connect, reportState]);

  // Decide whether this browser should act as a screen at all.
  // Re-evaluated on every navigation, not just on mount. Being on /screen is
  // itself an activation trigger, and it has to be: on a first-ever visit
  // there is no stored screenId and no opt-in flag yet (ScreenCode writes that
  // from its own effect, with no ordering guarantee against this one), and a
  // browser being used as a television is not necessarily detected as TV mode.
  // Without this the screen registered but never opened its command stream, so
  // the phone listed it as connected and then failed to reach it.
  useEffect(() => {
    // A browser being used as the remote must never also be a screen.
    // screenId lives in localStorage, which is shared across tabs, so without
    // this the phone registers as the SAME screen it is driving: every
    // command is delivered to the remote's own tab as well, and pressing
    // "Home" navigates the phone away from the remote. Found exactly that way
    // in a two-tab test.
    if (pathname === "/remote") {
      sourceRef.current?.close();
      sourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      activeRef.current = false;
      return;
    }

    if (activeRef.current) return;

    const stored = localStorage.getItem(SCREEN_ID_KEY);
    const optedIn = localStorage.getItem(SCREEN_OPT_IN_KEY) === "1";
    const askedNow = new URLSearchParams(window.location.search).get("screen") === "1";
    const onScreenPage = pathname === "/screen";
    if (askedNow || onScreenPage) localStorage.setItem(SCREEN_OPT_IN_KEY, "1");

    if (!(tvMode || optedIn || askedNow || onScreenPage || stored)) return;

    screenIdRef.current = stored;
    activeRef.current = true;
    void register();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tvMode, pathname]);

  // Teardown is its own effect so re-evaluating activation above can never
  // tear down a working stream.
  useEffect(() => {
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
    };
  }, []);

  // Report on navigation, so the phone knows where the TV went even when the
  // move came from the TV's own remote rather than the phone.
  useEffect(() => {
    if (!activeRef.current) return;
    void reportState();
  }, [pathname, reportState]);

  // Steady heartbeat: keeps the screen "online" and moves the phone's scrub
  // bar. Paused when the tab is hidden - a backgrounded TV tab is not playing
  // anything worth reporting, and this avoids waking the radio needlessly.
  useEffect(() => {
    if (!activeRef.current) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reportState();
    }, STATE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [reportState]);

  return null;
}
