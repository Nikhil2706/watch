import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentSession } from "@/lib/current-user";
import { getPlaybackPlan } from "@/lib/media";
import { SyncError, syncTarget } from "@/lib/subtitle-sync";

import { SyncWorkspace } from "./SyncWorkspace";

export const metadata: Metadata = { title: "Sync subtitles · Curator" };
export const dynamic = "force-dynamic";

/**
 * Sync a subtitle by eye (srt-timing.ts): the film plays with the subtitle
 * drawn over it, and the timing moves until the words land on the lips. The
 * /admin layout already limits this to admins. Playback here reports nothing
 * to Jellyfin, so syncing a film doesn't mark it watched.
 */
export default async function SyncPage({ searchParams }: { searchParams: Promise<{ itemId?: string; name?: string; fileId?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { itemId, name, fileId } = await searchParams;
  if (!itemId) return <p className="hint">Open this from a film's Subtitles list.</p>;

  let target;
  try {
    target = await syncTarget(itemId);
  } catch (error) {
    return <div className="error">{error instanceof SyncError ? error.message : "Couldn't open that film."}</div>;
  }
  const plan = await getPlaybackPlan(session, itemId, "desktop").catch(() => null);

  return (
    <SyncWorkspace
      itemId={itemId}
      title={target.title}
      files={target.files}
      initialFile={name && target.files.includes(name) ? name : (target.files[0] ?? null)}
      initialTry={fileId && /^\d+$/.test(fileId) ? Number(fileId) : null}
      playback={plan ? { mode: plan.mode, src: plan.src } : null}
    />
  );
}
