/**
 * Every artwork URL the browser is given, built in one place.
 *
 * These all point at /jf/*, so the browser fetches them through the proxy with
 * only its session cookie. Seven call sites used to write this shape out by
 * hand — five in media.ts plus CastRow and browse-data, which had each
 * re-derived the same person-avatar URL at a different size.
 *
 * The `tag` is the reason this matters rather than being tidiness. It is the
 * image's content hash, so including it makes the URL change when the artwork
 * does, which is what lets the proxy answer with
 * `Cache-Control: public, max-age=31536000, immutable`. A call site that
 * forgets it silently loses that, and nothing fails visibly. Here it cannot be
 * forgotten: no tag, no URL.
 *
 * Deliberately not `server-only` — client components build these too.
 */

export type ImageKind = "Primary" | "Backdrop" | "Thumb" | "Logo";

export interface ImageUrlOptions {
  /** Target width in CSS pixels. Jellyfin will not upscale past the source. */
  width: number;
  /** Target height. Omit for width-only scaling, which preserves aspect. */
  height?: number;
  /** JPEG quality, 1-100. */
  quality?: number;
  /** Backdrops are indexed; Jellyfin's first is 0. */
  index?: number;
}

/**
 * @param tag the image tag from `ImageTags[kind]` / `BackdropImageTags[i]`.
 *            Null or undefined means Jellyfin has no such image, and the
 *            caller gets null rather than a URL that would 404.
 */
export function imageUrl(
  kind: ImageKind,
  itemId: string,
  tag: string | null | undefined,
  options: ImageUrlOptions,
): string | null {
  if (!tag) return null;

  const params = new URLSearchParams({ fillWidth: String(options.width) });
  if (options.height !== undefined) params.set("fillHeight", String(options.height));
  params.set("quality", String(options.quality ?? 90));
  params.set("tag", tag);

  const path = kind === "Backdrop" ? `Backdrop/${options.index ?? 0}` : kind;
  return `/jf/Items/${itemId}/Images/${path}?${params.toString()}`;
}

/**
 * A person's portrait: square, because every place this is used is a round or
 * square avatar and asking Jellyfin for the square crop beats letting CSS
 * discard half the file it just downloaded.
 */
export function personImageUrl(
  personId: string,
  tag: string | null | undefined,
  size: number,
): string | null {
  return imageUrl("Primary", personId, tag, { width: size, height: size, quality: 90 });
}
