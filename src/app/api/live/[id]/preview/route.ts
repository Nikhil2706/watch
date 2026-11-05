import { channelOnNow, getChannel, skipGoneProgramme } from "@/lib/channels";
import { getItem, getPlaybackPlan } from "@/lib/media";
import { getSessionFromRequest } from "@/lib/session";
import { defaultTrack, listSubtitles } from "@/lib/subtitles";
import { resolvePlaybackClientFromRequest } from "@/lib/tv/detect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/live/:id/preview — the stream for what a channel has on now, for
 * the guide's preview (LiveGuide), with the subtitle tuning in would show. Through this viewer's own playback
 * plan, as tuning in is, so a title they could not open is not previewed.
 *
 * Nothing is reported to Jellyfin from the preview: browsing the guide is not
 * watching, and leaves no history. Between programmes (a channel's "next
 * in…") there is nothing to show; `nextAtMs` says when there will be.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });

  const { id } = await params;
  const found = getChannel(decodeURIComponent(id));
  if (!found) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const channel = (await skipGoneProgramme(found)) ? (getChannel(found.id) ?? found) : found;

  const now = Date.now();
  const on = channelOnNow(channel, now);
  if (!on) return Response.json({ offAir: true }, { headers: NO_STORE });
  if (now < on.startedAtMs || now >= on.playsUntilMs) {
    return Response.json({ between: true, nextAtMs: now < on.startedAtMs ? on.startedAtMs : on.endsAtMs }, { headers: NO_STORE });
  }

  const [plan, item] = await Promise.all([
    getPlaybackPlan(session, on.slot.itemId, await resolvePlaybackClientFromRequest()).catch(() => null),
    getItem(session, on.slot.itemId).catch(() => null),
  ]);
  if (!plan) return Response.json({ unavailable: true }, { headers: NO_STORE });
  // The track tuning in would switch on (the live page's own rule), so the
  // preview reads the same as the channel does.
  const subtitle = item ? defaultTrack(listSubtitles(item)) : null;
  return Response.json(
    {
      src: plan.src,
      mode: plan.mode,
      // Where the channel is, as of `atMs`; the preview adds the time since.
      offsetSeconds: on.offsetMs / 1000,
      atMs: now,
      playsUntilMs: on.playsUntilMs,
      subtitle: subtitle ? { url: subtitle.url, label: subtitle.label, language: subtitle.language } : null,
    },
    { headers: NO_STORE },
  );
}
