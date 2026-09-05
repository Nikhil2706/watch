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

  const query = new URLSearchParams({ fillWidth: "160", fillHeight: "240", quality: "90", tag });
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
      "Cache-Control": "private, max-age=86400",
    },
  });
}
