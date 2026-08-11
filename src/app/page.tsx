import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { Hero } from "@/components/media/Hero";
import { ProcessingRow } from "@/components/media/ProcessingRow";
import { Row } from "@/components/media/Row";
import { currentSession } from "@/lib/current-user";
import { getActiveJobs } from "@/lib/jobs";
import { listCurations } from "@/lib/curations";
import { getMemberships } from "@/lib/lists";
import { CuratorPicks } from "@/components/media/CuratorPicks";
import {
  getAllMovies,
  getGenres,
  getLatest,
  getResume,
  type MediaItem,
} from "@/lib/media";

export const dynamic = "force-dynamic";

/**
 * Home. Rows come straight from Jellyfin's own organisation of the library —
 * its resume positions, its "latest" ordering, its genre tags. Nothing here
 * re-derives metadata that Jellyfin already maintains.
 */
export default async function HomePage() {
  const session = await currentSession();
  // Middleware only checked that a cookie existed. This is the real check.
  if (!session) redirect("/login");

  const [resume, latest, genres] = await Promise.all([
    getResume(session).catch(() => []),
    getLatest(session).catch(() => []),
    getGenres(session).catch(() => []),
  ]);

  // Local, not from Jellyfin: these titles have been dropped into the watch
  // folder but are still being converted, so Jellyfin does not know about them.
  const processing = getActiveJobs();
  const picks = listCurations(12);

  // One request per genre row, in parallel. Capped at four rows so a large
  // library does not turn the home page into dozens of upstream calls.
  const genreRows = await Promise.all(
    genres.slice(0, 4).map(async (genre) => ({
      genre,
      items: await getAllMovies(session, { genre, limit: 20 }).catch(() => []),
    })),
  );

  // One batched membership lookup for every card on the page, rather than one
  // query per poster.
  const lists = getMemberships(session.userId, [
    ...new Set([
      ...resume.map((i) => i.Id),
      ...latest.map((i) => i.Id),
      ...genreRows.flatMap((row) => row.items.map((i) => i.Id)),
    ]),
  ]);

  const featured: MediaItem | undefined = resume[0] ?? latest[0];

  if (!featured) {
    return (
      <>
        <AppBar username={session.username} />
        <ProcessingRow jobs={processing} />
        <div className="empty">
          <p>Nothing in the library yet.</p>
          <p className="hint" style={{ margin: 0 }}>
            Once media is added and scanned in Jellyfin, it will appear here.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <AppBar username={session.username} />
      <Hero item={featured} />
      <Row title="Continue watching" items={resume} lists={lists} />
      <Row title="Recently added" items={latest} lists={lists} />
      <CuratorPicks picks={picks} />
      {genreRows.map(({ genre, items }) => (
        <Row key={genre} title={genre} items={items} lists={lists} />
      ))}
      {/* Last, deliberately: this is operational detail, and someone arriving to
          watch something should meet the library before a progress bar. */}
      <ProcessingRow jobs={processing} />
    </>
  );
}
