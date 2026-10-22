import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { TogetherAnswer } from "@/components/TogetherAnswer";
import { currentSession } from "@/lib/current-user";
import { getItem } from "@/lib/media";
import { itemHref } from "@/lib/slugs";
import { getAsk } from "@/lib/watch-together";

export const dynamic = "force-dynamic";

/**
 * Where a "wants to watch X with you" notification lands (watch-together.ts):
 * start a watch party for it, with you in charge, or not now. Only the person
 * asked can open it.
 */
export default async function TogetherPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { id } = await params;
  const ask = getAsk(id);
  if (!ask || ask.toUserId !== session.userId) notFound();

  // Already started: straight to the party.
  if (ask.roomId) redirect(`/party/${ask.roomId}`);

  const item = await getItem(session, ask.itemId).catch(() => null);
  const filmHref = item ? itemHref(item.Id, item.Name, item.ProductionYear) : "/";

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <div className="together">
        <h1>
          {ask.fromUsername} wants to watch <Link href={filmHref}>{ask.filmTitle}</Link> with you
        </h1>
        {!item ? (
          <p className="hint">That title isn&apos;t in the library any more.</p>
        ) : ask.answeredAt !== null ? (
          <p className="hint">
            You said not now. <Link href={filmHref}>Go to the film</Link>
          </p>
        ) : (
          <>
            <p className="hint">
              A watch party keeps you both at the same moment, with chat beside the film. You&apos;ll be in charge of
              play and pause; {ask.fromUsername} gets a link to join.
            </p>
            <TogetherAnswer askId={ask.id} filmHref={filmHref} />
          </>
        )}
      </div>
    </>
  );
}
