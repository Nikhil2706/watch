import Link from "next/link";
import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { currentSession } from "@/lib/current-user";
import { liveGuide } from "@/lib/live-guide";

export const dynamic = "force-dynamic";

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Live TV: every channel, what's on now (with how far in) and what's next,
 * from each channel's clock (channels.ts). Choosing one tunes in, live.
 */
export default async function LivePage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const now = Date.now();
  const channels = await liveGuide(session, now);

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <div className="page-head">
        <h1>Live TV</h1>
        <p className="hint" style={{ margin: 0 }}>
          Always on. Pick a channel and you join wherever it is.
        </p>
      </div>
      {channels.length === 0 ? (
        <div className="empty">
          <p>No channels yet.</p>
          {session.isAdmin ? (
            <p className="hint" style={{ margin: 0 }}>
              Make one in <Link href="/admin/channels">Admin › Channels</Link>.
            </p>
          ) : null}
        </div>
      ) : (
        <ol className="live-guide">
          {channels.map((c, i) => {
            const progress = Math.min(100, Math.max(0, ((now - c.now.startedAtMs) / (c.now.endsAtMs - c.now.startedAtMs)) * 100));
            return (
              <li key={c.id}>
                <Link href={`/live/${encodeURIComponent(c.id)}`} className="live-channel" {...(i === 0 ? { "data-tv-autofocus": "true" } : {})}>
                  <span className="live-channel-art">
                    {c.art ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.art} alt="" loading="lazy" />
                    ) : null}
                  </span>
                  <span className="live-channel-body">
                    <span className="live-channel-name">{c.name}</span>
                    <span className="live-channel-now">
                      <span className="live-dot" aria-hidden="true" /> {c.nowTitle}
                    </span>
                    <span className="live-progress" aria-hidden="true">
                      <span style={{ width: `${progress}%` }} />
                    </span>
                    <span className="hint">
                      until {clock(c.now.endsAtMs)}
                      {c.next ? ` · next: ${c.next.slot.name}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}
