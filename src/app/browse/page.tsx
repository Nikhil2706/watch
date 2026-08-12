import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { PosterCard } from "@/components/media/PosterCard";
import { currentSession } from "@/lib/current-user";
import { getMemberships } from "@/lib/lists";
import { getAllMovies, getGenres } from "@/lib/media";

export const dynamic = "force-dynamic";

/** Full catalogue as a grid, optionally filtered to one of Jellyfin's genres. */
export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<{ genre?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { genre } = await searchParams;

  const [items, genres] = await Promise.all([
    getAllMovies(session, { genre }).catch(() => []),
    getGenres(session).catch(() => []),
  ]);

  const lists = getMemberships(session.userId, items.map((i) => i.Id));

  return (
    <>
      <AppBar username={session.username} />

      <div style={{ padding: "18px 20px 6px" }}>
        <h1 style={{ margin: "0 0 12px", fontSize: "1.25rem" }}>
          {genre ? genre : "All movies"}{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: "0.9rem" }}>
            ({items.length})
          </span>
        </h1>

        <div className="people" style={{ marginBottom: 4 }}>
          <a
            className="chip"
            href="/browse"
            style={genre ? undefined : { borderColor: "var(--accent)", color: "var(--text)" }}
          >
            All
          </a>
          {genres.map((g) => (
            <a
              key={g}
              className="chip"
              href={`/browse?genre=${encodeURIComponent(g)}`}
              style={g === genre ? { borderColor: "var(--accent)", color: "var(--text)" } : undefined}
            >
              {g}
            </a>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="empty">Nothing here.</div>
      ) : (
        <div className="grid">
          {items.map((item) => (
            <PosterCard key={item.Id} item={item} lists={lists.get(item.Id)} />
          ))}
        </div>
      )}
    </>
  );
}
