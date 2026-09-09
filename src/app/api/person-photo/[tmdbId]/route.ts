import { currentSession } from "@/lib/current-user";
import { imageBytes } from "@/lib/tmdb-images";
import { personById } from "@/lib/tmdb-people";

export const runtime = "nodejs";

/**
 * GET /api/person-photo/{tmdbId}?size=w185 — one person's headshot.
 *
 * Same-origin on purpose. Every other image on this site comes through /jf/*
 * so a viewer's browser never makes a third-party request; a crew photo is the
 * first piece of artwork with no Jellyfin object behind it, and pointing an
 * <img> at image.tmdb.org would have told TMDB each viewer's IP and, via the
 * Referer, which film they were reading about. The bytes are cached in
 * tmdb_images on first request instead.
 *
 * The size is not taken from the query string as given: it is passed to
 * imageBytes(), which serves only renditions on its own allow-list. The TMDB
 * path never comes from the request at all — only the person id does, and the
 * path is looked up from the stored row.
 *
 * A miss 404s rather than redirecting upstream. That is deliberate: the card
 * then renders initials, which it already does for every person Jellyfin has
 * no photo of, so the failure mode is one the UI has always handled.
 *
 * This route is under /api/, which the middleware matcher excludes, so it
 * authenticates itself — a session, same as any page that would show a face.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ tmdbId: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { tmdbId } = await params;
  const id = Number.parseInt(tmdbId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return notFound();

  const person = personById(id);
  if (!person?.profilePath) return notFound();

  const size = new URL(request.url).searchParams.get("size") ?? "w185";
  const image = await imageBytes(person.profilePath, size);
  if (!image) return notFound();

  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.byteLength),
      // A headshot for a fixed TMDB id and rendition never changes, so this is
      // immutable in the strict sense. Private because the route is behind a
      // session and the response should not sit in a shared cache.
      "Cache-Control": "private, max-age=31536000, immutable",
      // The bytes are an image and nothing else; refuse to let a browser guess
      // otherwise, since they originate upstream rather than from this repo.
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Short-cached rather than no-store: a person TMDB has no photo of would
 * otherwise be re-requested on every render of every page they appear on.
 */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, max-age=3600" },
  });
}
