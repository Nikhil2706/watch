import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { TvSearchField } from "@/components/tv/TvSearchField";
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

  // Only non-group results carry a real Jellyfin id worth looking up a
  // list membership for — a group's "item" is a synthetic Id that doesn't
  // exist in Jellyfin.
  const lists = getMemberships(
    session.userId,
    matches.filter((m) => !m.groupId).map((m) => m.item.Id),
  );

  return (
    <>
      <AppBar username={session.username} query={query} langloisMode={session.langloisMode} />

      <TvSearchField initialQuery={query} />

      <div style={{ padding: "18px 20px 6px" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>
          {query ? `Results for “${query}”` : "Search"}
        </h1>
      </div>

      {!query ? (
        <div className="empty">Type a title in the search box above.</div>
      ) : matches.length === 0 ? (
        <div className="empty">No titles matched “{query}”.</div>
      ) : (
        <div className="grid">
          {matches.map((match) =>
            match.groupId ? (
              <PosterCard
                key={match.groupId}
                item={match.item}
                href={`/collection/${match.groupId}`}
                posterSrc={match.posterSrc}
                partsCount={match.partsCount}
                partsUnit={match.partsUnit}
              />
            ) : (
              <PosterCard
                key={match.item.Id}
                item={match.item}
                lists={lists.get(match.item.Id)}
                badge={match.reason}
              />
            ),
          )}
        </div>
      )}
    </>
  );
}
