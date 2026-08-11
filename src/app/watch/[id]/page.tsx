import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Player } from "@/components/media/Player";
import { currentSession } from "@/lib/current-user";
import { getItem, getPlaybackPlan, resumeSeconds } from "@/lib/media";

export const dynamic = "force-dynamic";

export default async function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ t?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id } = await params;
  const { t } = await searchParams;

  const item = await getItem(session, id);
  if (!item) notFound();

  let plan = null;
  let planError: string | null = null;
  try {
    plan = await getPlaybackPlan(session, id);
  } catch (error) {
    console.error("[watch] PlaybackInfo failed:", error);
    planError = "The media server could not prepare this title for playback.";
  }

  // An explicit ?t= wins over the stored resume position, so "Start over"
  // (which omits it) genuinely starts over.
  const startSeconds = t !== undefined ? Number(t) || 0 : resumeSeconds(item);

  return (
    <div className="player-page">
      <div className="player-bar">
        <Link className="btn ghost" href={`/item/${item.Id}`}>
          ‹ Back
        </Link>
        <span className="title">{item.Name}</span>
      </div>

      {plan ? (
        <Player
          itemId={item.Id}
          mediaSourceId={plan.mediaSourceId}
          playSessionId={plan.playSessionId}
          mode={plan.mode}
          src={plan.src}
          startSeconds={startSeconds}
          transcodeReasons={plan.transcodeReasons}
        />
      ) : (
        <div className="player-stage">
          <div className="player-msg">
            <strong>Cannot play this title</strong>
            {planError ??
              "The media server offered no playable stream for this file."}
          </div>
        </div>
      )}
    </div>
  );
}
