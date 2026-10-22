import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { HideSeenToggle } from "@/components/HideSeenToggle";
import { GetAppPrompt } from "@/components/GetAppPrompt";
import { Hero } from "@/components/media/Hero";
import { PickButton } from "@/components/media/PickButton";
import { ProcessingRow } from "@/components/media/ProcessingRow";
import { Row } from "@/components/media/Row";
import { PickRow } from "@/components/picks/PickRow";
import { PartyBanner } from "@/components/party/PartyBanner";
import { currentSession } from "@/lib/current-user";
import { episodeCards } from "@/lib/episode-cards";
import { getActiveJobs } from "@/lib/jobs";
import { getMemberships } from "@/lib/lists";
import { homePicksForViewer } from "@/lib/pick-views";
import { listLiveParties, listUpcomingParties } from "@/lib/party";
import { getRatings } from "@/lib/ratings";
import { MIN_SHELF_SIZE } from "@/lib/home-shelves";
import { todaysShelves } from "@/lib/tmdb-shelves";
import { episodeViewByPath, filmViewByPath } from "@/lib/tmdb-view";
import {
  collapseEpisodeGroups,
  getAllMovies,
  getGenres,
  getItemsByPaths,
  getLatest,
  getRecentlyWatched,
  getContinueWatching,
  type MediaItem,
} from "@/lib/media";

export const dynamic = "force-dynamic";

/** Cards in Home's Recently watched row; the rest are on /history. */
const RECENTLY_WATCHED_ROW = 12;

/**
 * Home. Rows come straight from Jellyfin's own organisation of the library —
 * its resume positions, its "latest" ordering, its genre tags. Nothing here
 * re-derives metadata that Jellyfin already maintains.
 *
 * The three rotating shelves are the exception, and only because Jellyfin has
 * nothing to build them from: it holds no cinematographers, no keywords and no
 * franchises. Those come from the TMDB store, cached for the day.
 */
export default async function HomePage() {
  const session = await currentSession();
  // Middleware only checked that a cookie existed. This is the real check.
  if (!session) redirect("/login");

  // Each fetch degrades to empty so one failing row cannot take the page
  // down. But if the latest-items call fails, Jellyfin itself is unreachable,
  // and "nothing in the library" would be the wrong thing to tell anyone.
  let libraryUnreachable = false;
  const [continuing, recent, latest, genres, shelves, picks] = await Promise.all([
    // Half-watched titles and the next episode of each show (next-up.ts).
    getContinueWatching(session).catch(() => ({ items: [] as MediaItem[], nextUp: new Set<string>() })),
    // What they have finished, newest first. The full list is /history.
    getRecentlyWatched(session, RECENTLY_WATCHED_ROW).catch(() => []),
    getLatest(session).catch(() => {
      libraryUnreachable = true;
      return [];
    }),
    getGenres(session).catch(() => []),
    // Local and cached for the day, so this costs a Map lookup on most loads.
    todaysShelves().catch(() => []),
    // Picks published in the last week, and any the curator has pinned.
    homePicksForViewer(session).catch(() => []),
  ]);

  const resume = continuing.items;

  // Local, not from Jellyfin: these titles have been dropped into the watch
  // folder but are still being converted, so Jellyfin does not know about them.
  const processing = getActiveJobs();

  const liveParties = listLiveParties();
  const upcomingParties = listUpcomingParties();

  // One request per genre row, in parallel. Capped at four rows so a large
  // library does not turn the home page into dozens of upstream calls.
  const genreRows = await Promise.all(
    genres.slice(0, 4).map(async (genre) => ({
      genre,
      // Collapsed here, not "Continue watching": these are browse-titles
      // rows, so a newly-added or genre-tagged show should read as one tile,
      // not one per episode — same reasoning as More like this below.
      collapsed: collapseEpisodeGroups(await getAllMovies(session, { genre, limit: 20 }).catch(() => [])),
    })),
  );
  const collapsedLatest = collapseEpisodeGroups(latest);

  // Leaving soon is a pick like the others (the site keeps its titles, the
  // curator writes it), and goes after them: what the curator chose to keep
  // on Home comes before what is on its way out.
  const leavingPick = picks.find((p) => p.leaving);
  const otherPicks = picks.filter((p) => !p.leaving);

  // "Hide what I've seen", the viewer's own switch. After collapsing, where a
  // show's tile counts as watched only when every episode is. Continue
  // watching is left alone: nothing in it is finished.
  if (session.hideWatched) {
    const unseen = (item: MediaItem) => item.UserData?.Played !== true;
    collapsedLatest.items = collapsedLatest.items.filter(unseen);
    for (const row of genreRows) row.collapsed.items = row.collapsed.items.filter(unseen);
  }

  // Today's franchise, crew and subject shelves. One cached listing resolves
  // every path on all three, and parental control applies on the way through —
  // so each shelf is measured again afterwards, since a franchise that loses a
  // film to the filter can drop below the two it needs.
  const shelfItems = shelves.length
    ? await getItemsByPaths(session, shelves.flatMap((s) => [...s.paths])).catch(
        () => new Map<string, MediaItem>(),
      )
    : new Map<string, MediaItem>();
  const shelfRows = shelves
    .map((s) => ({
      key: s.key,
      title: s.title,
      items: s.paths
        .map((p) => shelfItems.get(p))
        .filter((i): i is MediaItem => i !== undefined)
        .filter((i) => !session.hideWatched || i.UserData?.Played !== true),
      min: MIN_SHELF_SIZE[s.kind],
    }))
    .filter((row) => row.items.length >= row.min);

  // One batched membership lookup for every card on the page, rather than one
  // query per poster. Group tiles' synthetic ids simply match nothing here,
  // which is fine — PosterCard never renders list toggles for a group tile.
  const lists = getMemberships(session.userId, [
    ...new Set([
      ...resume.map((i) => i.Id),
      ...recent.map((i) => i.Id),
      ...collapsedLatest.items.map((i) => i.Id),
      ...genreRows.flatMap((row) => row.collapsed.items.map((i) => i.Id)),
      ...shelfRows.flatMap((row) => row.items.map((i) => i.Id)),
    ]),
  ]);

  // An episode in Continue watching or Recently watched is headed with its
  // show, with the show's poster and "S1 E1 · Title" beneath (episode-cards.ts).
  const {
    titles: resumeTitles,
    lines: resumeLines,
    posters: resumePosters,
  } = episodeCards(resume);
  // A next episode says so, so it doesn't read as one already started.
  for (const id of continuing.nextUp) {
    const line = resumeLines.get(id);
    resumeLines.set(id, line ? `Next: ${line}` : "Next episode");
  }
  const recentCards = episodeCards(recent);

  const featured: MediaItem | undefined = resume[0] ?? latest[0];

  if (!featured) {
    return (
      <>
        <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
        <PartyBanner live={liveParties} upcoming={upcomingParties} />
        <ProcessingRow jobs={processing} />
        {libraryUnreachable ? (
          <div className="empty">
            <p>The library is not answering right now.</p>
            <p className="hint" style={{ margin: 0 }}>
              Try again in a few minutes. In the app, films kept offline still play from Downloads.
            </p>
          </div>
        ) : (
          <div className="empty">
            <p>Nothing in the library yet.</p>
            <p className="hint" style={{ margin: 0 }}>
              Once media is added and scanned in Jellyfin, it will appear here.
            </p>
          </div>
        )}
      </>
    );
  }

  // One cached lookup for the single featured title. Ratings are held for a
  // week in SQLite, so this is normally a local read.
  const featuredRatings = await getRatings(featured.ProviderIds?.Imdb).catch(
    () => null,
  );

  // TMDB's title logo over the backdrop where it has one (67% of films); an
  // episode is headed with its real title rather than its filename stem.
  const featuredFilm = filmViewByPath(featured.Path);
  const featuredEpisode = featuredFilm ? null : episodeViewByPath(featured.Path);

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin={session.isAdmin} />
      <GetAppPrompt variant="banner" />
      <PartyBanner live={liveParties} upcoming={upcomingParties} />
      <Hero
        item={featured}
        imdb={featuredRatings?.imdb}
        title={featuredEpisode?.name}
        logoUrl={featuredFilm?.logoUrl}
        fallbackBackdrop={featuredFilm?.backdropUrl}
      />
      <div className="pick-entry">
        <PickButton />
        <HideSeenToggle initialOn={session.hideWatched} />
      </div>
      <Row
        title="Continue watching"
        items={resume}
        lists={lists}
        itemTitles={resumeTitles}
        itemBadges={resumeLines}
        itemPosters={resumePosters}
        // Every card is a poster now, a show's included, so the row is laid
        // out for posters; left to measure itself it would go landscape for
        // the episodes' own frames, which are no longer what it shows.
        shape={resumePosters.size > 0 ? "poster" : undefined}
        markWatched
        removable
      />
      {/* Left alone by "Hide what I've seen", like Continue watching: it is
          the viewer's own history, asked for by being on the page. */}
      <Row
        title="Recently watched"
        titleHref="/history"
        items={recent}
        lists={lists}
        itemTitles={recentCards.titles}
        itemBadges={recentCards.lines}
        itemPosters={recentCards.posters}
        shape="poster"
        // The tick is on here; pressing it marks the title unwatched again.
        markWatched
      />
      {otherPicks.map((pick) => (
        <PickRow key={pick.id} pick={pick} />
      ))}
      {leavingPick ? <PickRow pick={leavingPick} /> : null}
      <Row
        title="Recently added"
        items={collapsedLatest.items}
        lists={lists}
        itemHrefs={collapsedLatest.hrefs}
        itemPosters={collapsedLatest.posters}
        shape="poster"
        itemPartsCounts={collapsedLatest.partsCounts}
        itemPartsUnits={collapsedLatest.partsUnits}
      />
      {/* Rotates daily: one franchise, one crew member, one subject. None of
          these rows could exist before TMDB — see tmdb-shelves.ts. */}
      {shelfRows.map((row) => (
        <Row key={row.key} title={row.title} items={row.items} lists={lists} shape="poster" />
      ))}
      {genreRows.map(({ genre, collapsed }) => (
        <Row
          key={genre}
          title={genre}
          items={collapsed.items}
          lists={lists}
          itemHrefs={collapsed.hrefs}
          itemPosters={collapsed.posters}
          shape="poster"
          itemPartsCounts={collapsed.partsCounts}
          itemPartsUnits={collapsed.partsUnits}
        />
      ))}
      {/* Last, deliberately: this is operational detail, and someone arriving to
          watch something should meet the library before a progress bar. */}
      <ProcessingRow jobs={processing} />
    </>
  );
}
