"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  findNextFocusable,
  getFocusableElements,
  isTextEditable,
  scrollFocusedIntoView,
  type Direction,
} from "@/lib/tv/spatial-nav";
import { TV_MODE_COOKIE, viewportContent } from "@/lib/tv/constants";
import { installAppBack, registerBackHandler } from "@/lib/overlay-back";
import { holdKeyboard, isTvTextField, keyboardHeld, openKeyboard, releaseField } from "@/lib/tv/tv-fields";

/**
 * Root of the TV experience: detects/upgrades TV mode, and — only while TV
 * mode is active — owns arrow-key spatial navigation and an Escape/Back
 * handler stack. Mounted once in the root layout; every page benefits
 * without needing its own key handling, because navigation operates on
 * whatever is already focusable in the DOM (see spatial-nav.ts) rather than
 * on a per-component wiring.
 */

const KEY_TO_DIRECTION: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** A back handler returns true when it consumed Escape/Back, false to fall through. */
type BackHandler = () => boolean;

interface TvContextValue {
  tvMode: boolean;
  pushBackHandler: (handler: BackHandler) => () => void;
}

const TvContext = createContext<TvContextValue>({
  tvMode: false,
  pushBackHandler: () => () => {},
});

export function useTvMode(): boolean {
  return useContext(TvContext).tvMode;
}

/**
 * Registers `handler` as the topmost thing Escape/Back should try while this
 * component is mounted (a modal, an open dropdown, a fullscreen player).
 * Returning true from the handler consumes the key; returning false lets it
 * fall through to whatever was registered before it, and eventually to the
 * default (browser history back).
 */
export function useTvBack(handler: BackHandler, active = true): void {
  const { pushBackHandler } = useContext(TvContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return;
    return pushBackHandler(() => handlerRef.current());
  }, [active, pushBackHandler]);
}

/**
 * Focuses the page's declared `[data-tv-autofocus]` element, or failing
 * that the first focusable element outside the persistent header.
 *
 * Exported so a component whose primary focusable content only exists
 * after an async fetch (TvPairingLogin's code/QR, arriving after
 * /api/auth/device/start resolves) can call this itself once that content
 * actually exists — TvProvider's own autofocus effect below only runs once
 * per navigation and would otherwise focus nothing at all if it ran before
 * that content mounted.
 */
export function focusTvAutofocusTarget(): void {
  const autofocus = document.querySelector<HTMLElement>("[data-tv-autofocus]");
  if (autofocus) {
    autofocus.focus();
    return;
  }
  const focusable = getFocusableElements();
  // A page with nothing focusable of its own (an empty Picks, the pairing
  // code) lands on its own header link, so the D-pad always has an anchor.
  const first =
    focusable.find((el) => !el.closest(".appbar")) ??
    focusable.find((el) => el.closest(".appbar nav") && el.getAttribute("href") === window.location.pathname) ??
    focusable.find((el) => el.closest(".appbar nav"));
  first?.focus();
}

/** This document itself was loaded by Back/Forward (a full page load, not a client-side one). */
let backForwardLoadConsumed = false;
function isBackForwardLoad(): boolean {
  if (backForwardLoadConsumed) return false;
  backForwardLoadConsumed = true;
  const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return entry?.type === "back_forward";
}

/** The focusable whose centre is nearest a point in page coordinates. */
function nearestFocusable(x: number, y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const el of getFocusableElements()) {
    const rect = el.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 + window.scrollX - x;
    const dy = rect.top + rect.height / 2 + window.scrollY - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = el;
    }
  }
  return best;
}

/** Nothing (or only <body>) has focus — arrow keys would have no anchor. */
function nothingFocused(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
}

function isKnownTvUserAgent(): boolean {
  return /tizen|webos|web0s|googletv|androidtv|aft[bmnst]|crkey|hbbtv|viera|bravia|nettv|roku|appletv|smart-tv|smarttv/i.test(
    navigator.userAgent,
  );
}

/** Client-side refinement of the server's initial guess — the only place that can actually measure pointer/hover capability. */
function detectTvHeuristically(): boolean {
  if (isKnownTvUserAgent()) return true;
  const coarseNoHover = window.matchMedia("(hover: none) and (any-pointer: coarse), (hover: none) and (pointer: none)").matches;
  const large = window.innerWidth >= 960;
  return coarseNoHover && large;
}

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : undefined;
}

function writeTvModeCookie(value: "0" | "1"): void {
  document.cookie = `${TV_MODE_COOKIE}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

export function TvProvider({
  initialTvMode,
  children,
}: {
  /** The server's own guess (cookie override or UA sniff), applied to <html data-tv> before hydration. */
  initialTvMode: boolean;
  children: ReactNode;
}) {
  const [tvMode, setTvMode] = useState(initialTvMode);
  const backStack = useRef<BackHandler[]>([]);
  const pathname = usePathname();
  const lastMoveDirection = useRef<Direction>("down");
  const cameBack = useRef(false);
  /** Where focus last was, in page coordinates — see moveFocus. */
  const lastFocusSpot = useRef<{ x: number; y: number; path: string } | null>(null);

  useEffect(() => {
    if (!tvMode) return;
    function onFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === document.body) return;
      const rect = target.getBoundingClientRect();
      lastFocusSpot.current = {
        x: rect.left + rect.width / 2 + window.scrollX,
        y: rect.top + rect.height / 2 + window.scrollY,
        path: window.location.pathname,
      };
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [tvMode]);

  // Refine the server's guess once the browser can actually answer
  // hover/pointer questions. Only overrides when there is no explicit
  // cookie already pinning the choice — an explicit `?tv=0` from a real TV
  // browser (testing the desktop layout on it) must stick.
  useEffect(() => {
    const explicit = readCookie(TV_MODE_COOKIE);
    if (explicit === "1" || explicit === "0") return;
    const detected = detectTvHeuristically();
    if (detected !== tvMode) setTvMode(detected);
    writeTvModeCookie(detected ? "1" : "0");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-tv", tvMode ? "true" : "false");
    // Keep the viewport width in step when the client overrides the server's
    // guess (see TV_LAYOUT_WIDTH in constants.ts).
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const content = viewportContent(tvMode);
    if (meta && meta.content !== content) meta.content = content;
  }, [tvMode]);

  // Expose a console escape hatch for testing without editing the URL —
  // documented in HANDOFF.md / scripts/windows/README.md.
  useEffect(() => {
    (window as unknown as { __setTvMode?: (on: boolean) => void }).__setTvMode = (on: boolean) => {
      writeTvModeCookie(on ? "1" : "0");
      setTvMode(on);
    };
  }, []);

  // Text fields and the system keyboard (tv-fields.ts): focus alone keeps
  // the keyboard closed, OK opens it. Capture phase, so it also covers
  // focus moved by the WebView itself and runs before a form sees Enter.
  useEffect(() => {
    if (!tvMode) return;
    function onFocusIn(event: FocusEvent) {
      if (isTvTextField(event.target)) holdKeyboard(event.target);
    }
    function onFocusOut(event: FocusEvent) {
      const field = event.target;
      if (!isTvTextField(field)) return;
      // Only when focus really went elsewhere. The keyboard's own window
      // opening blurs the page for a moment with the field still the active
      // element; treating that as leaving would close the keyboard again.
      queueMicrotask(() => {
        if (document.activeElement !== field) releaseField(field);
      });
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter" || !isTvTextField(event.target) || !keyboardHeld(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      openKeyboard(event.target);
    }
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    window.addEventListener("keydown", onKeyDown, true);
    // A field focused before this ran (a page's autofocus).
    if (isTvTextField(document.activeElement)) holdKeyboard(document.activeElement);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [tvMode]);

  // The Android app's Back asks the page first on every page, not only once
  // a menu has opened (overlay-back.ts).
  useEffect(() => {
    installAppBack();
  }, []);

  // Escape reaches the stack through the keydown handler below; the Android
  // app's Back button never arrives as a key (MainActivity asks
  // window.__watchCloseOverlay), so the same handler registers there too.
  const pushBackHandler = useCallback((handler: BackHandler) => {
    backStack.current.push(handler);
    const unregisterAppBack = registerBackHandler(handler);
    return () => {
      backStack.current = backStack.current.filter((h) => h !== handler);
      unregisterAppBack();
    };
  }, []);

  const moveFocus = useCallback((direction: Direction) => {
    const active = document.activeElement;
    // Focus lost: the first press lands somewhere instead of doing nothing,
    // which from a couch reads as a dead remote. If focus was somewhere on
    // this page a moment ago (the Post button that just disabled itself, a
    // comment that was deleted, a panel that closed), resume from the
    // nearest thing to that spot — not from the top of the page. Otherwise
    // (the page never had focus) the page's default.
    if (nothingFocused() || !(active instanceof HTMLElement)) {
      const last = lastFocusSpot.current;
      const nearest = last && last.path === window.location.pathname ? nearestFocusable(last.x, last.y) : null;
      if (nearest) {
        nearest.focus();
        scrollFocusedIntoView(nearest, direction);
      } else {
        focusTvAutofocusTarget();
      }
      return;
    }
    const next = findNextFocusable(active, direction);
    if (!next) return;
    lastMoveDirection.current = direction;
    next.focus();
    scrollFocusedIntoView(next, direction);
  }, []);

  // Global key handling — only while TV mode is active, and never inside a
  // player (the video's own keyboard shortcuts, bound at the document level
  // by Vidstack, own arrow keys there; see Player.tsx / globals.css
  // data-tv-player-open).
  useEffect(() => {
    if (!tvMode) return;

    function onKeyDown(event: KeyboardEvent) {
      const playerOpen = document.body.dataset.tvPlayerOpen === "true";

      // (A party room has text fields beside the player — chat, a guest's
      // name — where Backspace must stay Backspace.)
      if (
        event.key === "Escape" ||
        (playerOpen && event.key === "Backspace" && !isTextEditable(event.target as Element | null))
      ) {
        // Backspace-as-Back only inside the player: some TV browsers send it
        // for the remote's Back button, and nowhere else in the app is a
        // literal Backspace keystroke meaningful (no free-text field relies
        // on it here because this branch never fires outside the player).
        for (let i = backStack.current.length - 1; i >= 0; i--) {
          if (backStack.current[i]?.()) {
            event.preventDefault();
            return;
          }
        }
        if (window.history.length > 1) {
          event.preventDefault();
          window.history.back();
        }
        return;
      }

      // The player owns the arrows only while focus is on it. A watch party
      // has a panel beside the player (chat, guest links, End); with focus
      // there, the D-pad moves through it as on any other page — standing
      // down for the whole page left that panel unreachable from a remote.
      if (playerOpen) {
        const target = event.target as Element | null;
        if (!target || target === document.body || target.closest(".player-stage")) return;
      }

      const direction = KEY_TO_DIRECTION[event.key];
      if (!direction) return;
      // Left/right belong to the caret while someone is typing — not while
      // the field is merely focused with the keyboard held closed.
      const active = document.activeElement;
      const typing = isTextEditable(active) && !(isTvTextField(active) && keyboardHeld(active));
      if ((direction === "left" || direction === "right") && typing) return;
      event.preventDefault();
      moveFocus(direction);
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [tvMode, moveFocus]);

  // Focus landing/restoration on every navigation: coming BACK to a page
  // prefers the element the user last focused there (by href, so it
  // survives a re-render with the same content); otherwise an explicit
  // data-tv-autofocus element, then the first focusable element outside the
  // persistent header. Only on Back: choosing Home from the header should
  // land on Home's hero, not wherever focus was an hour ago.
  useEffect(() => {
    if (!tvMode) return;
    const onPop = () => {
      cameBack.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [tvMode]);

  useEffect(() => {
    if (!tvMode) return;
    const back = cameBack.current || isBackForwardLoad();
    cameBack.current = false;

    const frame = requestAnimationFrame(() => {
      const stored = back ? sessionStorage.getItem(`tvFocus:${pathname}`) : null;
      if (stored) {
        const byHref = document.querySelector<HTMLElement>(
          `a[href="${CSS.escape(stored)}"]`,
        );
        if (byHref) {
          byHref.focus();
          scrollFocusedIntoView(byHref, "down");
          return;
        }
      }

      focusTvAutofocusTarget();
    });

    // Content that streams in after the first frame (Browse's grid, a
    // Suspense boundary) had nothing to focus yet: keep trying for a few
    // seconds, until something is focused.
    let observer: MutationObserver | null = new MutationObserver(() => {
      if (!nothingFocused()) return stop();
      focusTvAutofocusTarget();
      if (!nothingFocused()) stop();
    });
    const timeout = setTimeout(() => stop(), 5000);
    function stop() {
      observer?.disconnect();
      observer = null;
      clearTimeout(timeout);
    }
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(frame);
      stop();
    };
  }, [tvMode, pathname]);

  // Remember focus by href so returning to a page (Back from an item page to
  // Home, say) can land back on the same card rather than the page default.
  useEffect(() => {
    if (!tvMode) return;
    function onFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLAnchorElement)) return;
      sessionStorage.setItem(`tvFocus:${pathname}`, target.getAttribute("href") ?? "");
    }
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [tvMode, pathname]);

  return <TvContext.Provider value={{ tvMode, pushBackHandler }}>{children}</TvContext.Provider>;
}
