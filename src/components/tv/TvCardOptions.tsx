"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useCloseOnBack } from "@/lib/overlay-back";
import { CARD_OPTIONS_ATTR, cardActions, HOLD_MS, readCardOptions, type CardAction, type CardOptions } from "@/lib/tv/card-options";

import { useTvBack, useTvMode } from "./TvProvider";

/**
 * Hold OK on a poster for its options: the remote's way to the overlay
 * buttons a mouse or a finger uses (favourite, rewatch, mark watched, take
 * off Continue watching), which the D-pad cannot reach (card-options.ts).
 *
 * A short press still opens the title, on release rather than on press:
 * a link follows itself on keydown, which is too early to know it is a hold.
 * A remote sends a held OK as a second keydown before the keyup (about
 * 0.4 s on the Mi TV), so a second keydown, or HOLD_MS with the key still
 * down, opens the panel.
 *
 * One instance for the whole app, mounted inside TvProvider's tree; each
 * card names its options in a data attribute, so the cards stay server
 * components.
 */
export function TvCardOptions() {
  const tvMode = useTvMode();
  const router = useRouter();
  const [open, setOpen] = useState<{ options: CardOptions; link: HTMLAnchorElement } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The panel is portalled to <body>, which the server render has none of.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const panelRef = useRef<HTMLDivElement>(null);
  const hold = useRef<{ link: HTMLAnchorElement; timer: number; opened: boolean } | null>(null);

  const close = useCallback(() => setOpen(null), []);
  useCloseOnBack(open !== null, close);
  useTvBack(() => {
    if (!open) return false;
    const link = open.link;
    setOpen(null);
    requestAnimationFrame(() => link.isConnected && link.focus());
    return true;
  }, open !== null);

  useEffect(() => {
    if (!tvMode) return;

    function cardLink(target: EventTarget | null): { link: HTMLAnchorElement; options: CardOptions } | null {
      if (!(target instanceof HTMLAnchorElement) || !target.classList.contains("poster-link")) return null;
      const options = readCardOptions(target.closest(`[${CARD_OPTIONS_ATTR}]`)?.getAttribute(CARD_OPTIONS_ATTR));
      return options ? { link: target, options } : null;
    }

    function openFor(link: HTMLAnchorElement) {
      const found = cardLink(link);
      if (!found || !hold.current) return;
      hold.current.opened = true;
      window.clearTimeout(hold.current.timer);
      setOpen(found);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Enter") return;
      // Still held after the panel opened: the repeats would land on its
      // first row and press it. Nothing happens until the key is let go.
      if (hold.current?.opened) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const found = cardLink(event.target);
      if (!found) return;
      event.preventDefault();
      if (hold.current?.link === found.link) {
        // The remote's repeat for a held key.
        if (!hold.current.opened) openFor(found.link);
        return;
      }
      hold.current = { link: found.link, opened: false, timer: window.setTimeout(() => openFor(found.link), HOLD_MS) };
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== "Enter" || !hold.current) return;
      const { link, timer, opened } = hold.current;
      window.clearTimeout(timer);
      hold.current = null;
      if (!opened && event.target === link) link.click();
    }

    function onFocusOut() {
      if (!hold.current || hold.current.opened) return;
      window.clearTimeout(hold.current.timer);
      hold.current = null;
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("focusout", onFocusOut, true);
    };
  }, [tvMode]);

  // The panel takes focus as it opens, on its first row.
  useEffect(() => {
    if (open) requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** Up and down along the rows, and nowhere else: the page behind is not reachable while it is open. */
  function onPanelKeyDown(event: React.KeyboardEvent) {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") return;
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[Math.min(rows.length - 1, Math.max(0, i + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  async function run(action: CardAction) {
    if (!open || busy) return;
    const { options, link } = open;
    if (action.key === "play" || action.key === "info") {
      setOpen(null);
      router.push(action.key === "play" ? options.playHref : options.infoHref);
      return;
    }

    setBusy(true);
    // Where focus goes if this card leaves its row (taken off Continue
    // watching, or marked watched there): the next card, else the one before.
    // A card alone in its row has neither: then the next poster on the page.
    const poster = link.closest(".poster");
    const all = Array.from(document.querySelectorAll<HTMLAnchorElement>(".poster-link"));
    const neighbour =
      (poster?.nextElementSibling ?? poster?.previousElementSibling)?.querySelector<HTMLAnchorElement>(".poster-link") ??
      all.slice(all.indexOf(link) + 1).find((other) => other.getAttribute("href") !== link.getAttribute("href"));
    const neighbourHref = neighbour?.getAttribute("href") ?? null;
    let ok = false;
    let done = "";
    try {
      if (action.key === "favourite" || action.key === "rewatch") {
        const on = !(action.key === "favourite" ? options.favourite : options.rewatch);
        const response = await fetch(`/api/lists/${options.itemId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: action.key, on }),
        });
        ok = response.ok;
        done = `${on ? "Added to" : "Removed from"} ${action.key === "favourite" ? "Favourites" : "Rewatch"}`;
      } else if (action.key === "watched") {
        const response = await fetch(`/api/watched/${options.itemId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ watched: !options.watched }),
        });
        ok = response.ok;
        done = options.watched ? "Marked as not watched" : "Marked as watched";
      } else if (action.key === "remove") {
        const response = await fetch(`/api/continue/${options.itemId}`, { method: "POST" });
        ok = response.ok;
        done = "Removed from Continue watching";
      }
    } catch {
      ok = false;
    } finally {
      setBusy(false);
    }

    setOpen(null);
    setToast(ok ? `${options.title}: ${done}` : "That did not work. Try again.");
    if (!ok) {
      requestAnimationFrame(() => link.isConnected && link.focus());
      return;
    }
    router.refresh();
    const byHref = (href: string | null) =>
      href ? document.querySelector<HTMLAnchorElement>(`.poster-link[href="${CSS.escape(href)}"]`) : null;
    if (action.key === "favourite" || action.key === "rewatch") {
      // The card stays where it is.
      requestAnimationFrame(() => link.isConnected && link.focus());
      return;
    }
    // Taken off Continue watching, or marked watched there: the card leaves
    // its row once the page has redrawn. Focus waits for that, then lands on
    // the card if it is still there (another row), else on its neighbour.
    link.focus();
    let tries = 0;
    const settle = () => {
      if (link.isConnected && ++tries < 30) {
        window.setTimeout(settle, 100);
        return;
      }
      (byHref(link.getAttribute("href")) ?? byHref(neighbourHref))?.focus();
    };
    window.setTimeout(settle, 100);
  }

  if (!tvMode || !mounted) return null;

  return createPortal(
    <>
      {open ? (
        <div className="tv-options-backdrop" onClick={close}>
          <div
            ref={panelRef}
            className="tv-options"
            role="dialog"
            aria-modal="true"
            aria-label={`Options for ${open.options.title}`}
            onKeyDown={onPanelKeyDown}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="tv-options-title">{open.options.title}</p>
            {open.options.subtitle ? <p className="tv-options-sub">{open.options.subtitle}</p> : null}
            {cardActions(open.options).map((action) => (
              <button
                key={action.key}
                type="button"
                className={`tv-options-row tv-options-${action.key}`}
                disabled={busy}
                onClick={() => void run(action)}
              >
                {action.label}
              </button>
            ))}
            <p className="tv-options-hint">Back to close</p>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className="tv-options-toast" role="status">
          {toast}
        </div>
      ) : null}
    </>,
    document.body,
  );
}
