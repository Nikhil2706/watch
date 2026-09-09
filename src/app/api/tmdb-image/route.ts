import { currentSession } from "@/lib/current-user";
import { imageBytes } from "@/lib/tmdb-images";
import { isCacheableImagePath } from "@/lib/tmdb-shape";

export const runtime = "nodejs";

/**
 * GET /api/tmdb-image?path=/abc.png&size=w500 — any cached TMDB image.
 *
 * The generic sibling of /api/person-photo. That route exists because a crew
 * member has no Jellyfin object to hang a photo on; this one exists because a
 * title logo and a backdrop have the same problem for the same reason, and
 * were being hotlinked straight from image.tmdb.org — which is precisely the
 * leak the person-photo route was written to avoid. Every other image on this
 * site comes through /jf/*, so the browser makes no third-party request; an
 * <img src="https://image.tmdb.org/..."> tells TMDB the viewer's IP and, via
 * the Referer, which film they are looking at.
 *
 * The path comes from the query string here, unlike person-photo where it is
 * looked up from a row. That is safe because isCacheableImagePath() admits
 * only TMDB's own shape — a leading slash, a base62 name, one of three
 * extensions — which rules out traversal, a query string and a
 * protocol-relative host; and imageBytes() serves only sizes on its own
 * allow-list. Neither the host nor the scheme is ever caller-supplied.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  const size = url.searchParams.get("size") ?? "w500";

  if (!isCacheableImagePath(path)) return notFound();

  const image = await imageBytes(path, size);
  if (!image) return notFound();

  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": image.contentType,
      "Content-Length": String(image.bytes.byteLength),
      // A TMDB file path names one immutable rendition, so this can be cached
      // as hard as the browser allows. Private: the route is behind a session.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, max-age=3600" },
  });
}
