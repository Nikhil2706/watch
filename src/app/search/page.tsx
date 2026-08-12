import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { getMemberships } from "@/lib/lists";
import { smartSearch } from "@/lib/media";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { q } = await searchParams;
  const query = (q ?? "").trim();
  // Same engine as the type-ahead. They used to differ, which meant the
  // dropdown could offer matches this page then failed to find.
  const matches = query ? await smartSearch(session, query, 60).catch(() => []) : [];
  const results = matches.map((m) => m.item);
  const reasons = new Map(matches.map((m) => [m.item.Id, m.reason]));

  const lists = getMemberships(session.userId, results.map((i) => i.Id));

  return (
    <>
      <AppBar username={session.username} query={query} />

      <div style={{ padding: "18px 20px 6px" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>
          {query ? `Results for “${query}”` : "Search"}
        </h1>
      </div>

      {!query ? (
        <div className="empty">Type a title in the search box above.</div>
      ) : results.length === 0 ? (
        <div className="empty">No titles matched “{query}”.</div>
      ) : (
        <div className="grid">
          {results.map((item) => (
            <PosterCard
              key={item.Id}
              item={item}
              lists={lists.get(item.Id)}
              badge={reasons.get(item.Id)}
            />
          ))}
        </div>
      )}
    </>
  );
}
