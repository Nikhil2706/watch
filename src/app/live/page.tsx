import Link from "next/link";
import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { LiveGuide } from "@/components/live/LiveGuide";
import { currentSession } from "@/lib/current-user";
import { liveGuideGrid } from "@/lib/live-guide";

export const dynamic = "force-dynamic";

/**
 * Live TV, laid out as Pluto TV does it: the highlighted channel playing at
 * the top beside what is on, and the guide below, every channel three hours
 * ahead (LiveGuide), from each channel's clock (channels.ts).
 */
export default async function LivePage({ searchParams }: { searchParams: Promise<{ channel?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const now = Date.now();
  const channels = await liveGuideGrid(session, now);
  // Back from a channel (down on the remote): that channel highlighted.
  const { channel: from } = await searchParams;

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      {channels.length === 0 ? (
        <>
          <div className="page-head">
            <h1>Live TV</h1>
          </div>
          <div className="empty">
            <p>No channels yet.</p>
            {session.isAdmin ? (
              <p className="hint" style={{ margin: 0 }}>
                Make one in <Link href="/admin/channels">Admin › Channels</Link>.
              </p>
            ) : null}
          </div>
        </>
      ) : (
        <LiveGuide channels={channels} serverNowMs={now} initialChannelId={typeof from === "string" ? from : null} />
      )}
    </>
  );
}
