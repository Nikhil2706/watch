import { cookies } from "next/headers";

import { PlayerMount } from "@/components/media/PlayerMount";
import { ScreeningClock } from "@/components/media/ScreeningClock";
import { getItem, getPlaybackPlan, posterUrl } from "@/lib/media";
import {
  SCREENING_COOKIE,
  getScreeningProgress,
  refusalMessage,
  resolveScreeningSession,
  screeningState,
  type ScreeningRefusal,
} from "@/lib/screening";
import { screeningSession } from "@/lib/screening-playback";
import { defaultTrack, listSubtitles } from "@/lib/subtitles";

export const dynamic = "force-dynamic";

/**
 * The screening room.
 *
 * Deliberately narrow: no AppBar, no search, no Browse link, no comments, no
 * "back to library" anywhere. It must be structurally obvious that this is one
 * film and not the front door of something bigger.
 */
export default async function ScreeningPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ why?: string; play?: string }>;
}) {
  const { id } = await params;
  const { why, play } = await searchParams;

  if (id === "unavailable") {
    return <Ended reason={(why as ScreeningRefusal) ?? "invalid"} />;
  }

  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SCREENING_COOKIE)?.value;
  const resolved = sessionId ? resolveScreeningSession(sessionId) : null;

  // Wrong screening for this cookie, or none at all. Not a login form.
  if (!resolved || resolved.screeningId !== id) {
    return <Ended reason="invalid" />;
  }

  const state = screeningState(resolved);
  if (state.state === "ended") {
    return <Ended reason={state.reason} label={resolved.recipientLabel} title={resolved.items[0]?.title} />;
  }

  const item = resolved.items[0];
  if (!item) return <Ended reason="invalid" />;

  const guestSession = await screeningSession(resolved.jellyfinDeviceId);
  if (!guestSession) return <Ended reason="invalid" />;

  const media = await getItem(guestSession, item.jellyfinItemId).catch(() => null);

  if (!play) {
    return (
      <div className="screening">
        <div className="screening-card">
          {media ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="screening-poster" src={posterUrl(media, 360) ?? ""} alt="" />
          ) : null}
          <div className="screening-body">
            <p className="screening-eyebrow">A screening for {resolved.recipientLabel ?? "you"}</p>
            <h1>{media?.Name ?? item.title}</h1>
            <p className="screening-sub">
              {[media?.ProductionYear, media?.OfficialRating].filter(Boolean).join(" · ")}
            </p>

            {resolved.message ? <blockquote className="screening-note">{resolved.message}</blockquote> : null}

            <ScreeningClock endsAt={state.endsAt} />

            <a className="btn" href={`/s/${id}?play=1`}>
              Play
            </a>

            <p className="screening-fineprint">
              This link was sent to you. It expires, and the sender can see that you
              have opened it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const plan = await getPlaybackPlan(guestSession, item.jellyfinItemId).catch(() => null);
  if (!plan || !media) {
    return (
      <div className="screening">
        <div className="screening-card">
          <div className="screening-body">
            <h1>Cannot play this title</h1>
            <p className="screening-sub">The media server offered no playable stream for this file.</p>
          </div>
        </div>
      </div>
    );
  }

  const subtitles = listSubtitles(media);
  const preferred = defaultTrack(subtitles);
  // Our own row, never Jellyfin's UserData — screenings share one account, so
  // UserData would hand this guest the previous guest's stopping point.
  const startSeconds = Math.floor(getScreeningProgress(resolved.sessionId, item.jellyfinItemId) / 10_000_000);

  return (
    <div className="player-page">
      <div className="player-bar">
        <span className="title">{media.Name}</span>
        <ScreeningClock endsAt={state.endsAt} compact />
      </div>
      <PlayerMount
        itemId={media.Id}
        mediaSourceId={plan.mediaSourceId}
        playSessionId={plan.playSessionId}
        mode={plan.mode}
        src={plan.src}
        title={media.Name}
        poster={posterUrl(media, 640)}
        startSeconds={startSeconds}
        screeningProgress
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
    </div>
  );
}

/**
 * Never a 404, and never a login form — a login form shown to someone with no
 * account is the most confusing possible ending. Names what it was where we
 * still know, since title is snapshotted at creation.
 */
function Ended({
  reason,
  label,
  title,
}: {
  reason: ScreeningRefusal;
  label?: string | null;
  title?: string | null;
}) {
  return (
    <div className="screening">
      <div className="screening-card">
        <div className="screening-body">
          <p className="screening-eyebrow">{label ? `For ${label}` : "Screening room"}</p>
          <h1>{refusalMessage(reason)}</h1>
          {title ? <p className="screening-sub">{title}</p> : null}
          <p className="screening-fineprint">
            If you would still like to see it, ask whoever sent you this for another link.
          </p>
        </div>
      </div>
    </div>
  );
}
