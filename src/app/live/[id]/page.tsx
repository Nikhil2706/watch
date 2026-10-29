import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PlayerMount } from "@/components/media/PlayerMount";
import { channelGuide, getChannel, neighbours } from "@/lib/channels";
import { currentSession } from "@/lib/current-user";
import { episodeCards } from "@/lib/episode-cards";
import { getItem, getPlaybackPlan, posterUrl } from "@/lib/media";
import { defaultTrack, listSubtitles } from "@/lib/subtitles";
import { resolvePlaybackClientFromRequest } from "@/lib/tv/detect";

export const dynamic = "force-dynamic";

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Tuned to a channel (channels.ts): what is on now, worked out from the
 * channel's clock, opened in the ordinary player at the point the channel has
 * reached, live (no pausing or skipping). When the programme ends the player
 * comes back here for the next one; up/down go to the channels either side.
 */
export default async function LiveChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const channel = getChannel(decodeURIComponent(id));
  if (!channel) notFound();

  const now = Date.now();
  const [current, next] = channelGuide(channel, now, 2);
  const around = neighbours(channel.id);
  const hrefOf = (cid: string | null) => (cid ? `/live/${encodeURIComponent(cid)}` : null);

  if (!current) {
    return (
      <div className="player-page">
        <div className="player-bar">
          <Link className="btn ghost" href="/live">
            ‹ Channels
          </Link>
          <span className="title">{channel.name}</span>
        </div>
        <div className="player-stage">
          <div className="player-msg">
            <strong>Off air</strong>
            This channel has nothing in its lineup yet.
          </div>
        </div>
      </div>
    );
  }

  // Through this viewer's own listing: a title they could not open themselves
  // (parental control, hidden) is not shown to them here either.
  const item = await getItem(session, current.slot.itemId).catch(() => null);
  const plan = item ? await getPlaybackPlan(session, item.Id, await resolvePlaybackClientFromRequest()).catch(() => null) : null;
  const subtitles = item ? listSubtitles(item) : [];
  const preferred = defaultTrack(subtitles);
  const label = item ? (episodeCards([item]).lines.get(item.Id) ?? null) : null;
  const show = item ? (episodeCards([item]).titles.get(item.Id) ?? null) : null;

  return (
    <div className="player-page">
      <div className="player-bar">
        <Link className="btn ghost" href="/live">
          ‹ Channels
        </Link>
        <span className="title">
          {channel.name}: {show ? `${show} · ${label ?? current.slot.name}` : current.slot.name}
          <span className="hint"> · until {clock(current.endsAtMs)}{next ? `, then ${next.slot.name}` : ""}</span>
        </span>
      </div>

      {item && plan ? (
        <PlayerMount
          key={`${channel.id}:${current.startedAtMs}`}
          itemId={item.Id}
          mediaSourceId={plan.mediaSourceId}
          playSessionId={plan.playSessionId}
          mode={plan.mode}
          src={plan.src}
          title={item.Name}
          poster={posterUrl(item, 640)}
          // Where the channel is now; the player keeps it there (live mode).
          startSeconds={current.offsetMs / 1000}
          transcodeReasons={plan.transcodeReasons}
          subtitles={subtitles.map((t) => ({
            index: t.index,
            label: t.label,
            language: t.language,
            url: t.url,
            recommended: t.recommended,
          }))}
          defaultSubtitleIndex={preferred?.index ?? null}
          live={{
            channelId: channel.id,
            channelName: channel.name,
            startedAtMs: current.startedAtMs,
            endsAtMs: current.endsAtMs,
            previousHref: hrefOf(around.previous),
            nextHref: hrefOf(around.next),
          }}
        />
      ) : (
        <div className="player-stage">
          <div className="player-msg">
            <strong>Not available to you right now</strong>
            {current.slot.name} is on until {clock(current.endsAtMs)}.
            {around.next ? (
              <>
                {" "}
                <Link href={hrefOf(around.next)!}>Next channel ›</Link>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
