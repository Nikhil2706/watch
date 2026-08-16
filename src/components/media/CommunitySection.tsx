import { getRatingSummary, getUserRating, listComments } from "@/lib/community";

import { CommunityClient } from "./CommunityClient";

/**
 * Server wrapper: fetches the initial comment tree, rating summary and the
 * viewer's own rating in one server-side pass (no client round trip before
 * first paint), then hands it to the interactive part.
 *
 * Same `imdbId`-optional, `return null` pattern as AccoladesSection/
 * RatingsRow — a show with no linked series id yet simply has nothing to
 * key this section on, so it's absent rather than broken.
 */
export function CommunitySection({
  imdbId,
  filmTitle,
  filmHref,
  currentUserId,
  currentUsername,
}: {
  imdbId: string | null | undefined;
  filmTitle: string;
  filmHref: string;
  currentUserId: string;
  currentUsername: string;
}) {
  if (!imdbId) return null;

  const comments = listComments(imdbId);
  const rating = getRatingSummary(imdbId);
  const yourRating = getUserRating(imdbId, currentUserId);

  return (
    <div className="community-section">
      <h3>Us</h3>
      <CommunityClient
        imdbId={imdbId}
        filmTitle={filmTitle}
        filmHref={filmHref}
        initialComments={comments}
        initialAverage={rating.average}
        initialCount={rating.count}
        initialYourRating={yourRating}
        currentUsername={currentUsername}
      />
    </div>
  );
}
