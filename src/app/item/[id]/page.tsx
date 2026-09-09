import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { CuratorNote } from "@/components/media/CuratorNote";
import { AccoladesSection } from "@/components/media/AccoladesSection";
import { CreditsRow } from "@/components/media/CreditsRow";
import { FetchSubtitlesButton } from "@/components/media/FetchSubtitlesButton";
import { CommunitySection } from "@/components/media/CommunitySection";
import { CuratorPicks } from "@/components/media/CuratorPicks";
import { ListButtons } from "@/components/media/ListButtons";
import { RatingsRow } from "@/components/media/RatingsRow";
import { SpecialFeaturesRow } from "@/components/media/SpecialFeaturesRow";
import { OfflineButton } from "@/components/offline/OfflineButton";
import { getCuratorNote } from "@/lib/notifications";
import { getRatingSummary } from "@/lib/community";
import { getCachedContentWarning, toDisplaySignals } from "@/lib/content-warnings";
import { curationsForItem } from "@/lib/curations";
import { getMemberships } from "@/lib/lists";
import { getRatings } from "@/lib/ratings";
import { mergeCredits } from "@/lib/credit-cards";
import { rankSimilar } from "@/lib/similar-rank";
import { creditsForSubject } from "@/lib/tmdb-people";
import { suggestionsForPath } from "@/lib/tmdb-similar";
import { episodeViewByPath, filmViewByPath } from "@/lib/tmdb-view";
import { resolveAccolade, resolveBlurb } from "@/lib/scraping/resolve";
import { resolveTriviaForFilm } from "@/lib/scraping/trivia";
import { listSubtitles } from "@/lib/subtitles";
import { Row } from "@/components/media/Row";
import { SeriesRow } from "@/components/media/SeriesRow";
import { currentSession } from "@/lib/current-user";
import {
  backdropUrl,
  collapseEpisodeGroups,
  formatRuntime,
  getEpisodeContext,
  getItem,
  getItemsByImdbIds,
  getSimilar,
  getSpecialFeaturesForFilm,
  qualityLabel,
  resumeSeconds,
} from "@/lib/media";
import { StartPartyButton } from "@/components/party/StartPartyButton";
import { getSeriesContextForFilm } from "@/lib/scraping/film-series";
import { extractJellyfinId, itemHref, watchHref } from "@/lib/slugs";

export const dynamic = "force-dynamic";

/** "$14.2M" — approximate on purpose; TMDB's figures are not audited. */
function money(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${value}`;
}

export default async function ItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect("/login");

  const { id: rawId } = await params;
  const id = extractJellyfinId(rawId);
  const item = await getItem(session, id);
  if (!item) notFound();

  const [similar, ratings, episodeContext, specialFeatures] = await Promise.all([
    getSimilar(session, id).catch(() => []),
    // The IMDb id comes from Jellyfin, so no title matching is needed.
    getRatings(item.ProviderIds?.Imdb).catch(() => null),
    // Null for anything that isn't a grouped episode.
    getEpisodeContext(session, item).catch(() => null),
    // Making-ofs and documentaries mapped to this film, its franchise, its
    // director or its cast. Empty for almost every title, so it costs one
    // local lookup and only reaches Jellyfin when something is actually
    // mapped.
    getSpecialFeaturesForFilm(session, item).catch(() => []),
  ]);
  // Once every episode in a group shares the same OMDb Genres/People, they
  // become each other's best "similar" match by Jellyfin's own metric — so
  // without this, "More like this" on episode 1 fills up with episodes 2-10
  // instead of anything actually similar. Siblings get their own row below.
  const similarOthers = episodeContext
    ? similar.filter((s) => !episodeContext.siblingIds.has(s.Id))
    : similar;
  // Every episode Jellyfin's own /Similar picked from a DIFFERENT show (not
  // this one — those were already filtered above) collapses to one "N parts"
  // tile for that show, same as Search and Browse already do.
  const collapsedSimilar = collapseEpisodeGroups(similarOthers);
  const futureTitles = new Map(
    (episodeContext?.future ?? [])
      .filter((f) => f.label)
      .map((f) => [f.item.Id, f.label as string]),
  );
  // Synchronous local-DB reads, not network fetches — no Promise.all needed.
  // The public read path only ever touches resolve.ts (blurb/accolade) and
  // trivia.ts's resolveTriviaForFilm: both return short display strings,
  // never a scraped_articles.full_text.
  const imdbId = item.ProviderIds?.Imdb;
  const blurb = imdbId ? resolveBlurb(imdbId) : null;
  const accolade = imdbId ? resolveAccolade(imdbId) : null;
  const trivia = imdbId ? resolveTriviaForFilm(imdbId) : [];
  const ratingSummary = imdbId ? getRatingSummary(imdbId) : null;
  const usRating = ratingSummary && ratingSummary.count > 0 ? { average: ratingSummary.average!, count: ratingSummary.count } : null;
  const contentWarning = imdbId ? getCachedContentWarning(imdbId) : null;
  // Only this viewer's own pick, if the curator sent them one for this film.
  const curatorNote = imdbId ? getCuratorNote(session.userId, imdbId) : null;
  const contentWarningDisplay = contentWarning ? toDisplaySignals(contentWarning) : null;

  // "In this series" — every film Wikipedia's own film-series lists carry
  // for this franchise (see film-series.ts), not just the ones owned. The
  // context lookup is a synchronous local read; resolving which entries are
  // actually owned is one batched Jellyfin call for every matched imdb id at
  // once (see getItemsByImdbIds — NOT one call per id, which is what broke
  // this: Jellyfin's per-id provider filter turned out to be a silent no-op).
  const seriesContext = imdbId ? getSeriesContextForFilm(imdbId) : null;
  const seriesItems = await getItemsByImdbIds(
    session,
    (seriesContext?.entries ?? []).map((e) => e.imdb_id).filter((id): id is string => id !== null),
  );

  const picks = curationsForItem(id);
  const subtitles = listSubtitles(item);
  const futureIds = (episodeContext?.future ?? []).map((f) => f.item.Id);
  const seriesItemIds = Array.from(seriesItems.values(), (i) => i.Id);
  const allLists = getMemberships(session.userId, [id, ...futureIds, ...seriesItemIds]);
  const lists = allLists.get(id);
  const backdrop = backdropUrl(item, 1600);
  const runtime = formatRuntime(item.RunTimeTicks);
  const quality = qualityLabel(item);
  const resume = resumeSeconds(item);

  const source = item.MediaSources?.[0];
  const audio = source?.MediaStreams?.filter((s) => s.Type === "Audio") ?? [];
  // The file's own path, which is what every TMDB table here is keyed on —
  // Jellyfin item ids do not survive a library rebuild and paths do. It comes
  // from the item, not the media source, and DETAIL_FIELDS already asks for it.
  const filePath = item.Path ?? null;

  // Jellyfin knows the cast, and Director/Writer/Producer. It holds ZERO
  // people of type DirectorOfPhotography, Editor, Composer or ProductionDesign
  // across all 1,181 items, which is why the Cinematography and Editing rows
  // written here originally have always rendered empty. TMDB has those for 368
  // titles; mergeCredits puts both sources in one Cast row and one Crew row.
  const tmdbCredits = filePath ? creditsForSubject("path", filePath) : [];

  // Title logo, tagline, original title and trailer, all from the projection
  // layer rather than the raw payload. Null for anything not cached, and every
  // use below is optional — coverage is 67% / 57% / partial / 75%.
  const film = filePath ? filmViewByPath(filePath) : null;

  // An episode file links to the SHOW, so filmViewByPath returns nothing for
  // one; this reads its own row out of the cached season payload instead. That
  // payload already carries each episode's crew and guest stars, so naming who
  // directed this particular hour costs no request.
  const episode = filePath ? episodeViewByPath(filePath) : null;

  // An episode folds its own crew and guest stars into the same two rows a
  // film gets. Jellyfin's people come first either way, so anyone it already
  // knows keeps their person page and their portrait.
  const { cast, crew } = mergeCredits(item.People ?? [], [
    ...tmdbCredits,
    ...(episode?.credits ?? []),
  ]);

  // TMDB's recommendations, intersected with what is owned. Measured across
  // 401 films: median 0, mean 0.6, and 57% of films get nothing at all — so
  // this cannot BE the row, and is used to rank and label Jellyfin's instead.
  // See similar-rank.ts.
  const suggestions = filePath ? suggestionsForPath(filePath) : null;

  // TMDB agreeing with Jellyfin about a pairing is independent evidence that
  // the pairing is real, so those move to the front of the row and say so.
  // Nothing is removed and the row never gets shorter — on the 57% of films
  // where TMDB has nothing owned to offer, this is exactly the old ordering.
  const jellyfinSimilar = collapsedSimilar.items.map((i) => ({
    ...i,
    imdbId: i.ProviderIds?.Imdb ?? null,
  }));
  // Owned films TMDB suggests that Jellyfin's own /Similar did not return.
  // Mean 0.6 per film, so this usually adds nothing — but when it does, the
  // alternative was silently dropping a title that is sitting on the disk.
  const alreadyListed = new Set(
    jellyfinSimilar.map((i) => i.imdbId).filter((id): id is string => id !== null),
  );
  const extraImdbIds = [...(suggestions?.endorsedImdbIds ?? [])].filter(
    (imdb) => !alreadyListed.has(imdb),
  );
  const extraItems = extraImdbIds.length
    ? Array.from((await getItemsByImdbIds(session, extraImdbIds)).values(), (i) => ({
        ...i,
        imdbId: i.ProviderIds?.Imdb ?? null,
      })).filter((i) => i.Id !== item.Id)
    : [];

  const rankedSimilar = rankSimilar(
    jellyfinSimilar,
    suggestions?.endorsedImdbIds ?? new Set<string>(),
    extraItems,
  );
  const similarBadges = new Map(
    [...rankedSimilar.endorsed].map((itemId) => [itemId, "Also on TMDB"]),
  );

  return (
    <div className="detail">
      <AppBar username={session.username} langloisMode={session.langloisMode} />

      <section className="hero">
        {backdrop ? (
          <div
            className="hero-bg"
            style={{ backgroundImage: `url("${backdrop}")` }}
            aria-hidden="true"
          />
        ) : null}
        <div className="hero-content">
          {/* TMDB has a title logo for 67% of the library. Where there is one it
              stands in for the heading; where there is not, the heading is
              unchanged. The h1 stays in the document either way, visually
              hidden, so the page keeps its heading for a screen reader. */}
          {film?.logoUrl ? (
            <>
              <h1 className="sr-only">{item.Name}</h1>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="hero-logo" src={film.logoUrl} alt={item.Name} />
            </>
          ) : (
            // An episode's item name is derived from its filename, so it reads
            // "The West Wing S05E01". TMDB has the title the episode was given.
            <h1>{episode?.name || item.Name}</h1>
          )}
          {film?.tagline ? <p className="tagline">{film.tagline}</p> : null}
          <div className="meta">
            {item.ProductionYear ? <span>{item.ProductionYear}</span> : null}
            {runtime ? <span>{runtime}</span> : null}
            {item.OfficialRating ? <span className="chip">{item.OfficialRating}</span> : null}
            {/* IMDb is the number a film club actually argues about, so it is
                the one in the headline. TMDB's own score only stands in when
                the film has no IMDb id. Resolution and codec used to sit here
                too — they are file detail and now live in the footer line. */}
            {ratings?.imdb ? (
              <span className="meta-rating">
                <span className="mark mark-imdb">IMDb</span>
                {ratings.imdb}
              </span>
            ) : item.CommunityRating ? (
              <span>★ {item.CommunityRating.toFixed(1)}</span>
            ) : null}
            {/* Only ever set when it differs from the title, so this is "Ran"
                beside 乱 rather than "Memento" beside "Memento". */}
            {film?.originalTitle ? (
              <span className="orig-title">{film.originalTitle}</span>
            ) : null}
            {episode ? (
              <span>
                Season {episode.seasonNumber}, Episode {episode.episodeNumber}
              </span>
            ) : null}
            {episode?.airDate ? (
              <span>
                {new Date(`${episode.airDate}T00:00:00Z`).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </span>
            ) : null}
          </div>
          {/* Three sources, most specific first. Episodes in a group share the
              show's OMDb blurb, so every hour of a series otherwise says the
              same thing about the series; TMDB has one for this episode. For a
              film, TMDB's overview is consistently present and better written
              than whatever scraper won inside Jellyfin — but Jellyfin's is
              kept as the fallback, since 11 films are cached with none. */}
          {episode?.overview || film?.overview || item.Overview ? (
            <p>{episode?.overview || film?.overview || item.Overview}</p>
          ) : null}
          {curatorNote ? <CuratorNote note={curatorNote} /> : null}
          <div className="btn-row">
            <ListButtons
              itemId={item.Id}
              initialFavourite={lists?.has("favourite") ?? false}
              initialRewatch={lists?.has("rewatch") ?? false}
              variant="inline"
            />
            <Link
              className="btn"
              data-tv-autofocus="true"
              href={watchHref(item.Id, item.Name, item.ProductionYear, resume)}
            >
              ▶ {resume > 0 ? `Resume at ${Math.floor(resume / 60)}m` : "Play"}
            </Link>
            {resume > 0 ? (
              <Link className="btn ghost" href={watchHref(item.Id, item.Name, item.ProductionYear)}>
                Start over
              </Link>
            ) : null}
            {session.langloisMode ? (
              // "Langlois mode" — a per-user grant (see the langlois_mode
              // column comment in schema.ts), curator-set from the Invites
              // tab. Goes through the same /jf/* proxy as everything else;
              // it succeeds here (and 403s for anyone else) purely because
              // applyRestrictedPolicy() turned EnableContentDownloading on
              // for this user's Jellyfin account and no one else's — no
              // extra gating needed in this route.
              <a className="btn ghost" href={`/jf/Items/${item.Id}/Download`}>
                ⬇ Download film
              </a>
            ) : null}
            {/* Renders only inside an app shell that can store files; a plain
                browser sees nothing. Not Langlois-gated — that grant is about
                exporting the original file, this is a sandboxed copy. */}
            <OfflineButton itemId={item.Id} title={item.Name} />
            <StartPartyButton jellyfinId={item.Id} />
            {/* 75% of the library has one. Opens on YouTube rather than
                embedding: an embed would load Google's player into a page that
                otherwise makes no third-party request. */}
            {film?.trailerUrl ? (
              <a className="btn ghost" href={film.trailerUrl} target="_blank" rel="noopener noreferrer">
                ▶ Trailer
              </a>
            ) : null}
          </div>
        </div>
      </section>

      <div className="detail-body">
        {item.Genres?.length ? (
          <div className="chip-line">
            {item.Genres.map((g) => (
              <Link key={g} className="chip" href={`/browse?dim=genre&value=${encodeURIComponent(g)}`}>
                {g}
              </Link>
            ))}
          </div>
        ) : null}

        {/* For an episode, TMDB's score for THIS episode rather than whatever
            the file inherited — the difference between "the show is good" and
            "this hour is good", which is the whole point of per-episode data. */}
        <RatingsRow
          ratings={ratings}
          community={episode?.voteAverage ?? item.CommunityRating}
          accolade={accolade}
          usRating={usRating}
        />

        {/* Shown to everyone, not just parental-control accounts — this is
            informational (helping someone decide), separate from the filter
            that hides a title outright. contentWarningDisplay is null both
            when there's genuinely nothing flagged AND when the backfill
            hasn't reached this title yet — deliberately not distinguished
            here, since neither case has anything honest to say. */}
        {contentWarningDisplay ? (
          <div className="subtitle-line">
            <span className="subtitle-label">Content notes</span>
            {contentWarningDisplay.certifications.map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
            {contentWarningDisplay.topics.slice(0, 8).map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
            {contentWarningDisplay.topics.length > 8 ? (
              <span className="subtitle-label">+{contentWarningDisplay.topics.length - 8} more</span>
            ) : null}
            {contentWarningDisplay.hasDddSource ? (
              <span className="content-warning-attribution">
                Sexual content/violence data{" "}
                <a href="https://www.doesthedogdie.com" target="_blank" rel="noopener">
                  Powered by DoesTheDogDie.com
                </a>
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Which languages are available matters to a room deciding what to
            put on; the codec and container do not. Those moved to the footer. */}
        {subtitles.length > 0 ? (
          <div className="subtitle-line">
            <span className="subtitle-label">Subtitles</span>
            {subtitles.map((track) =>
              session.langloisMode ? (
                <a
                  key={track.index}
                  className={`chip${track.recommended ? " chip-accent" : ""}`}
                  title={(track.recommended ? "Recommended by the curator \u2014 " : "") + "Download this subtitle file"}
                  href={track.url}
                  download={`${item.Name} - ${track.label}.vtt`}
                >
                  {track.recommended ? "\u2605 " : ""}
                  {track.label} \u2b07
                </a>
              ) : (
                <span
                  key={track.index}
                  className={`chip${track.recommended ? " chip-accent" : ""}`}
                  title={track.recommended ? "Recommended by the curator" : undefined}
                >
                  {track.recommended ? "\u2605 " : ""}
                  {track.label}
                </span>
              ),
            )}
          </div>
        ) : (
          <FetchSubtitlesButton itemId={item.Id} />
        )}

        <AccoladesSection blurb={blurb} trivia={trivia} />
      </div>

      <SpecialFeaturesRow features={specialFeatures} />

      {/* Two rows, not five. Directed by / Written by / Cinematography /
          Edited by / Produced by were separate rails, three of them a single
          card wide, and TMDB's crew would have made it seven. The department
          moves onto the card instead, beside where a character already sits. */}
      <CreditsRow people={cast} heading="Cast" />
      <CreditsRow people={crew} heading="Crew" limit={14} />

      {episodeContext && episodeContext.future.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <Row
            title="Future episodes"
            items={episodeContext.future.map((f) => f.item)}
            lists={allLists}
            itemTitles={futureTitles}
          />
        </div>
      ) : null}

      {seriesContext && seriesContext.entries.length > 1 ? (
        <div style={{ marginTop: 28 }}>
          <SeriesRow
            title={`In the ${seriesContext.seriesName} series`}
            entries={seriesContext.entries}
            items={seriesItems}
            lists={allLists}
            currentImdbId={imdbId}
          />
        </div>
      ) : null}

      {picks.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <CuratorPicks picks={picks} heading="Curator's notes on this" />
        </div>
      ) : null}

      {imdbId ? (
        <div style={{ marginTop: 28 }}>
          <CommunitySection
            imdbId={imdbId}
            filmTitle={item.Name}
            filmHref={itemHref(item.Id, item.Name, item.ProductionYear)}
            currentUserId={session.userId}
            currentUsername={session.username}
          />
        </div>
      ) : null}

      {rankedSimilar.items.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <Row
            title="More like this"
            items={rankedSimilar.items}
            itemHrefs={collapsedSimilar.hrefs}
            itemPosters={collapsedSimilar.posters}
            shape="poster"
            itemPartsCounts={collapsedSimilar.partsCounts}
            itemPartsUnits={collapsedSimilar.partsUnits}
            itemBadges={similarBadges}
          />
        </div>
      ) : null}

      {/* Last, small, and not in cards. A film club cares what the film is,
          not what container it happens to be in — but the information is still
          worth having when a playback problem needs explaining. */}
      {/* Known for 46% of the library, so this is absent more often than not.
          A quiet line beside the file detail, not a panel. */}
      {film?.budget || film?.revenue ? (
        <p className="file-line">
          {[
            film.budget ? `Budget ${money(film.budget)}` : null,
            film.revenue ? `Box office ${money(film.revenue)}` : null,
          ]
            .filter(Boolean)
            .join("  ·  ")}
        </p>
      ) : null}

      <p className="file-line">
        {[
          source?.Container ? source.Container.toUpperCase() : null,
          source?.Size ? `${(source.Size / 1e9).toFixed(2)} GB` : null,
          quality,
          audio.length > 0
            ? audio.map((a) => a.DisplayTitle ?? a.Codec).join(" / ")
            : null,
        ]
          .filter(Boolean)
          .join("  ·  ")}
      </p>
    </div>
  );
}
