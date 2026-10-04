import { env } from "@/lib/env";
import { verifyResourceSignature } from "@/lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/thumb/{itemId}?tag=...&sig=... — one item's poster, for the
 * curator console.
 *
 * Why this exists rather than reusing /jf/Items/{id}/Images/Primary: that
 * proxy authenticates on the session cookie, and the console is a local
 * file:// page, so its requests are cross-site and Lax cookies never travel.
 * An <img> also cannot carry the X-Admin-Key header the rest of the console
 * uses. The result was that every library poster in the console was simply
 * broken — the Accolades film grid included, since it shipped.
 *
 * So the URL carries its own authorisation: a signature over "{itemId}:{tag}"
 * keyed by the admin key, minted server-side wherever these URLs are handed
 * out. The key itself never appears in a URL, history or log; the signature
 * unlocks exactly one item's poster at one image version, and grants nothing
 * else. Poster art is the whole scope.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> },
): Promise<Response> {
  const { itemId } = await params;
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag") ?? "";
  const sig = url.searchParams.get("sig") ?? "";

  if (!tag || !sig || !verifyResourceSignature(`${itemId}:${tag}`, env.adminApiKey, sig)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  /*
   * The same size the site's own posters ask for (posterUrl in media.ts:
   * 320x480 at quality 90), not a smaller one of its own.
   *
   * Jellyfin resizes a poster the first time a given size is asked for and
   * keeps the result. At 160x240 nothing but the console ever asked, so
   * opening a grid of a few hundred films meant a few hundred fresh resizes
   * on a two-core machine — the "slow the first time". At the site's size
   * the copy is already there for every poster anyone has browsed past, and
   * the browser scales it down.
   */
  const query = new URLSearchParams({ fillWidth: "320", fillHeight: "480", quality: "90", tag });
  let upstream: Response;
  try {
    upstream = await fetch(
      `${env.jellyfinUrl}/Items/${encodeURIComponent(itemId)}/Images/Primary?${query.toString()}`,
      { headers: { "X-Emby-Token": env.jellyfinApiKey }, signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    return new Response("Upstream unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "image/jpeg",
      // The tag changes whenever the poster does, so a signed URL is safe to
      // cache hard — that is the point of signing rather than inlining bytes.
      // A year and immutable: at a day, the console re-fetched every poster
      // each morning for nothing.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
