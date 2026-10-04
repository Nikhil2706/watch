"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { androidBrowser, appUpdateStatus, getAppUpdater, inApp, tvBrowser, type AppUpdateStatus } from "@/lib/app-update";

/**
 * The ⋯ menu's app line, which differs by where the page is open:
 *
 * - In the app (1.6+): its version, and "Update to X" whenever GitHub has a
 *   newer release — the launch prompt is easy to wave away, this isn't.
 * - In an older app, which can't be asked: a way to the /app page.
 * - In a phone browser on Android: "Get the Android app".
 * - Anywhere else: nothing.
 *
 * Decided after mount: none of it is knowable on the server, and guessing
 * would disagree with the server-rendered HTML.
 */
export function AppVersionItem() {
  const [where, setWhere] = useState<"app" | "old-app" | "android" | "tv" | "none">("none");
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [state, setState] = useState<"idle" | "checking" | "starting" | "started" | "failed">("idle");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (getAppUpdater()) {
      setWhere("app");
      void appUpdateStatus()
        .then(setStatus)
        .catch(() => setStatus(null));
    } else if (inApp()) {
      setWhere("old-app");
    } else if (tvBrowser()) {
      setWhere("tv");
    } else if (androidBrowser()) {
      setWhere("android");
    }
  }, []);

  // A dot on the ⋯ button, so an update is visible without opening the menu.
  useEffect(() => {
    const root = document.documentElement;
    if (status?.available) root.dataset.appUpdate = "1";
    else delete root.dataset.appUpdate;
  }, [status]);

  if (where === "none") return null;
  if (where === "android") return <Link href="/app">Get the Android app</Link>;
  if (where === "tv") return <Link href="/app">Get the TV app</Link>;
  if (where === "old-app") return <Link href="/app">App updates</Link>;

  async function check() {
    setState("checking");
    setNote(null);
    try {
      const fresh = await appUpdateStatus(true);
      setStatus(fresh);
      setState("idle");
      if (fresh && !fresh.available) setNote(fresh.latest ? "You have the latest version." : "Couldn't reach the update server.");
    } catch {
      setState("failed");
      setNote("Couldn't reach the update server.");
    }
  }

  async function update() {
    const plugin = getAppUpdater();
    if (!plugin) return;
    setState("starting");
    try {
      const result = await plugin.update();
      if (result.started) {
        setState("started");
        setNote("Downloading — Android will ask you to install it.");
      } else {
        setState("idle");
        setNote(result.reason === "up-to-date" ? "You have the latest version." : "This build updates over USB.");
      }
    } catch {
      setState("failed");
      setNote("Couldn't reach the update server.");
    }
  }

  const version = status?.current.name ? `Watch ${status.current.name}` : "Watch";
  return (
    <div className="appbar-more-app">
      {status?.available && status.latest ? (
        <button type="button" className="appbar-more-update" onClick={() => void update()} disabled={state === "starting" || state === "started"}>
          {state === "starting" ? "Starting update…" : `Update to Watch ${status.latest.name}`}
        </button>
      ) : (
        <button type="button" className="appbar-more-check" onClick={() => void check()} disabled={state === "checking" || status?.dev}>
          {version}
          <span>{status?.dev ? "dev build" : state === "checking" ? "Checking…" : "Check for updates"}</span>
        </button>
      )}
      {note ? <p className="appbar-more-note">{note}</p> : null}
    </div>
  );
}
