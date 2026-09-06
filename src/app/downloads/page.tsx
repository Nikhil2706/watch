import type { Metadata } from "next";

import { DownloadsScreen } from "@/components/offline/DownloadsScreen";

export const metadata: Metadata = { title: "Downloads · Watch" };

/**
 * Deliberately a static shell around a client component, with no data fetching
 * of its own.
 *
 * This is the one page that must render with no network — the service worker
 * precaches it by name for exactly that reason — so it cannot depend on a
 * server round trip to produce anything. Everything it shows comes from the
 * device: the native bridge lists what is actually stored there.
 *
 * It is also why there is no auth check here. Offline there is no way to run
 * one, and there is nothing to protect: the files are already on the device,
 * put there by whoever was logged in at the time.
 */
export default function DownloadsPage() {
  return (
    <main className="wrap dl-page">
      <h1 className="dl-heading">Downloads</h1>
      <p className="note">
        Films kept on this device. They play with no connection, subtitles and all.
      </p>
      <DownloadsScreen />
    </main>
  );
}
