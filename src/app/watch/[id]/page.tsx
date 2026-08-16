import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PlayerMount } from "@/components/media/PlayerMount";
import { currentSession } from "@/lib/current-user";
import { logEvent } from "@/lib/events";
import { getItem, getPlaybackPlan, posterUrl, resumeSeconds } from "@/lib/media";
import { defaultTrack, listSubtitles } from "@/lib/subtitles";

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
    logEvent({
      category: "playback",
      severity: "error",
      source: "playback_info",
      message: `PlaybackInfo failed for item ${id}`,
      detail: { error: error instanceof Error ? error.message : String(error) },
      itemId: id,
      username: session.username,
    });
    planError = "The media server could not prepare this title for playback.";
  }

  // Every selectable track, ordered recommended-first, plus the one to switch
  // on automatically. Both are resolved server-side so the player receives a
  // decision rather than having to make one.
  const subtitles = listSubtitles(item);
  const preferred = defaultTrack(subtitles);

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
        <PlayerMount
          itemId={item.Id}
          mediaSourceId={plan.mediaSourceId}
          playSessionId={plan.playSessionId}
          mode={plan.mode}
          src={plan.src}
          title={item.Name}
          poster={posterUrl(item, 640)}
          startSeconds={startSeconds}
          transcodeReasons={plan.transcodeReasons}
          subtitles={subtitles.map((t) => ({
            index: t.index,
            label: t.label,
            language: t.language,
            url: t.url,
            recommended: t.recommended,
          }))}
          defaultSubtitleIndex={preferred?.index ?? null}
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
