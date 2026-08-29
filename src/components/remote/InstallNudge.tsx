"use client";

import { useEffect, useState } from "react";

/**
 * "Add this to your home screen" prompt for the remote.
 *
 * The remote is the one page in this app people genuinely want as an app icon:
 * it is reached in a hurry, one-handed, while something is already on the
 * television. A browser tab is the wrong container for that.
 *
 * Two very different paths, because the platforms differ:
 *
 *  - Chromium fires `beforeinstallprompt`, which can be captured and replayed
 *    later from a button of our own. That is the good path: one tap.
 *  - iOS Safari has no such event and never will; installing is a manual
 *    Share -> Add to Home Screen. All we can do is show the instruction, and
 *    only to iOS users who are not already installed, or it is just noise.
 *
 * Dismissal is remembered, and the whole thing is suppressed once running
 * standalone (i.e. already installed), so it never nags someone who did what
 * it asked.
 */

const DISMISSED_KEY = "jfg.remote.installDismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's own non-standard flag.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function InstallNudge() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true); // assume hidden until checked

  useEffect(() => {
    if (isStandalone()) return;
    if (localStorage.getItem(DISMISSED_KEY) === "1") return;
    setDismissed(false);
    if (isIos()) setShowIosHint(true);

    function onBeforeInstall(event: Event) {
      // Chromium shows its own mini-infobar otherwise; suppressing it lets the
      // prompt appear where it makes sense rather than on arrival.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    }

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", () => setDismissed(true));
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setDismissed(true);
  }

  if (dismissed) return null;
  if (!deferred && !showIosHint) return null;

  return (
    <aside className="install-nudge">
      <div className="install-copy">
        <strong>Add Remote to your home screen</strong>
        {deferred ? (
          <span>Opens full-screen, straight to the remote — no tab hunting.</span>
        ) : (
          <span>
            Tap the Share button, then <strong>Add to Home Screen</strong>.
          </span>
        )}
      </div>
      <div className="install-actions">
        {deferred ? (
          <button
            className="remote-primary"
            onClick={async () => {
              await deferred.prompt();
              // Either outcome ends this prompt's life: the event cannot be
              // replayed, and Chromium will fire a fresh one on a later visit
              // if the app still is not installed.
              await deferred.userChoice.catch(() => undefined);
              setDeferred(null);
              dismiss();
            }}
          >
            Add
          </button>
        ) : null}
        <button className="install-dismiss" onClick={dismiss} aria-label="Dismiss install prompt">
          Not now
        </button>
      </div>
    </aside>
  );
}
