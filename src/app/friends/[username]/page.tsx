import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { DiaryList } from "@/components/media/DiaryList";
import { currentSession } from "@/lib/current-user";
import { DIARY_LIMIT, friendDiary } from "@/lib/friends-diary";

export const dynamic = "force-dynamic";

/**
 * A friend's diary (friends-diary.ts): everything they have finished, newest
 * first, a section per month; each line with the day, whether it was a
 * rewatch, their stars and their review. Only for a friend who shares what
 * they watch; anyone else is a 404, the same as a page that isn't there.
 */
export default async function FriendDiaryPage({ params }: { params: Promise<{ username: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const { username } = await params;
  const diary = await friendDiary(session, decodeURIComponent(username)).catch(() => null);
  if (!diary) notFound();


  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <div className="page-head">
        <h1>{diary.friend.username}&apos;s diary</h1>
        <p className="hint" style={{ margin: 0 }}>
          {diary.entries.length} watched
          {diary.notShown ? ` · ${diary.notShown} more you can't open here` : null} ·{" "}
          <Link href="/friends">All friends ›</Link>
        </p>
      </div>

      {!diary.entries.length ? (
        <div className="empty">
          <p>Nothing here yet.</p>
        </div>
      ) : null}

      <DiaryList entries={diary.entries} />
      {diary.truncated ? (
        <p className="hint" style={{ textAlign: "center" }}>
          Showing the most recent {DIARY_LIMIT}.
        </p>
      ) : null}
    </>
  );
}
