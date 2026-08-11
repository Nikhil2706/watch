import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { search } from "@/lib/media";

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
  const results = query ? await search(session, query).catch(() => []) : [];

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
            <PosterCard key={item.Id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}
