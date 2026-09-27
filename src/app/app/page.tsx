import type { Metadata } from "next";
import Link from "next/link";

import { InAppUpdate } from "@/components/InAppUpdate";
import { APP_APK_URL, getLatestAppRelease } from "@/lib/app-release";

export const metadata: Metadata = { title: "Get the app · Watch" };

/**
 * "Get the app": the Android APK straight from the latest GitHub release, and
 * what Android asks along the way. Reachable signed out (see middleware.ts),
 * since a new member installs first and signs in inside the app.
 *
 * There is no store listing, so the first install is a sideload. After that
 * the app updates itself (UpdateChecker.java, and the ⋯ menu's update line),
 * which the page says, so nobody comes back here for every release.
 */
export default async function AppPage() {
  const release = await getLatestAppRelease();

  return (
    <main className="app-page">
      <p style={{ margin: "0 0 18px" }}>
        <Link href="/">← Watch</Link>
      </p>
      <h1>Get the app</h1>
      <p className="page-sub">
        Watch for Android: keep films on your phone for offline, and it updates itself.
      </p>

      <InAppUpdate />

      <div className="app-get">
        <a className="app-download" href={APP_APK_URL}>
          Download for Android
          <small>{release ? `Watch ${release.versionName} · from GitHub` : "Latest version · from GitHub"}</small>
        </a>

        <ol className="app-steps">
          <li>Tap <b>Download for Android</b>. If Chrome warns that the file might be harmful, choose <b>Download anyway</b>.</li>
          <li>Open the downloaded file from the notification.</li>
          <li>
            Android asks whether Chrome may install apps: tap <b>Settings</b>, turn on <b>Allow from this
            source</b>, go back, then tap <b>Install</b>.
          </li>
          <li>Open <b>Watch</b> and sign in with your account.</li>
        </ol>

        <p className="app-note">
          You only do this once. New versions arrive inside the app: it asks when one is ready, and the ⋯ menu
          always shows your version and an update button.
          <br />
          <br />
          On an iPhone there is no app yet — in Safari, tap Share, then <b>Add to Home Screen</b>.
        </p>
      </div>
    </main>
  );
}
