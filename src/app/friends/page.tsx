import Link from "next/link";
import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { currentSession } from "@/lib/current-user";
import { friendsOverview } from "@/lib/friends-diary";
import { dayOf } from "@/lib/watch-history";

export const dynamic = "force-dynamic";

/** Friends who share what they watch, each opening their diary (friends-diary.ts). */
export default async function FriendsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const friends = friendsOverview(session.userId);

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <div className="page-head">
        <h1>Friends</h1>
        <p className="hint" style={{ margin: 0 }}>
          What they&apos;ve watched, rated and reviewed. <Link href="/history">Yours is in History ›</Link>
        </p>
      </div>
      {!friends.length ? (
        <div className="empty">
          <p>No friends are sharing what they watch yet.</p>
        </div>
      ) : (
        <ul className="friends-list">
          {friends.map(({ friend, finished, lastTitle, lastAt }) => (
            <li key={friend.id}>
              <Link href={`/friends/${encodeURIComponent(friend.username)}`}>
                <span className="friends-name">{friend.username}</span>
                <span className="hint">
                  {finished ? `${finished} watched` : "Nothing watched yet"}
                  {lastTitle && lastAt ? ` · last: ${lastTitle}, ${dayOf(lastAt)}` : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
