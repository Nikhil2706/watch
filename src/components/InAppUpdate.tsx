"use client";

import { useEffect, useState } from "react";

import { appUpdateStatus, getAppUpdater, inApp, type AppUpdateStatus } from "@/lib/app-update";

/**
 * /app opened inside the app: downloading the APK again would be the wrong
 * offer. Shows the installed version and, when there is one, the update —
 * and hides the page's download section (html[data-in-app] in the CSS below).
 * An app older than 1.6 can't be asked its version; for it, the download
 * button is still the way to update, so the section stays.
 */
export function InAppUpdate() {
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [capable, setCapable] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inApp() || !getAppUpdater()) return;
    setCapable(true);
    document.documentElement.dataset.inApp = "1";
    void appUpdateStatus(true)
      .then(setStatus)
      .catch(() => setNote("Couldn't reach the update server."));
    return () => {
      delete document.documentElement.dataset.inApp;
    };
  }, []);

  if (!capable) return null;

  async function update() {
    const plugin = getAppUpdater();
    if (!plugin) return;
    setBusy(true);
    try {
      const result = await plugin.update();
      setNote(result.started ? "Downloading — Android will ask you to install it." : "You have the latest version.");
    } catch {
      setNote("Couldn't reach the update server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 18, borderRadius: 12, background: "var(--panel)" }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        You're using the app{status?.current.name ? ` — Watch ${status.current.name}` : ""}.
      </p>
      {status?.available && status.latest ? (
        <button type="button" className="app-download" style={{ marginTop: 14, border: 0 }} onClick={() => void update()} disabled={busy}>
          {busy ? "Starting…" : `Update to Watch ${status.latest.name}`}
        </button>
      ) : status ? (
        <p style={{ margin: "6px 0 0", color: "var(--muted)" }}>
          {status.dev ? "This is the dev build." : status.latest ? "It's up to date." : "Couldn't check for updates right now."}
        </p>
      ) : null}
      {note ? <p style={{ margin: "10px 0 0", color: "var(--muted)" }}>{note}</p> : null}
    </div>
  );
}
