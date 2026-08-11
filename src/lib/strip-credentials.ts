import "server-only";

/**
 * Removes Jellyfin credential parameters from a URL or a playlist body.
 *
 * Jellyfin hands out its access token in two places that both end up pointed at
 * the browser, because media players fetch segments without being able to set
 * headers:
 *
 *   1. `PlaybackInfo` → `MediaSources[].TranscodingUrl`, which embeds
 *      `&ApiKey=<token>` and would otherwise be rendered straight into the page
 *      as the player's `src`.
 *   2. The generated `.m3u8` bodies, whose segment URIs carry the same token.
 *
 * Both are the session's real Jellyfin token — verified against the sessions
 * table — and each is a fully working credential (`GET /Items?api_key=…`
 * returns the entire catalogue). Either one reaching client-side JavaScript
 * would undo the whole point of this app.
 *
 * Stripping them is safe because every such URL is re-requested through /jf/*,
 * where the proxy re-attaches the token server-side from the session row.
 */
const CREDENTIAL_PARAMS =
  /(ApiKey|api_key|X-Emby-Token|X-MediaBrowser-Token|X-Emby-Authorization)=[^&\s"']*/gi;

export function stripCredentials(text: string): string {
  return (
    text
      .replace(CREDENTIAL_PARAMS, "")
      // Tidy the separators the removal leaves behind, so the resulting URLs are
      // still well formed: "?&a=1" -> "?a=1", "a=1&&b=2" -> "a=1&b=2", and a
      // dangling "?" or "&" is dropped — both at end of line for bare segment
      // URIs, and before the closing quote of a URI="…" attribute, which is how
      // #EXT-X-MEDIA and #EXT-X-KEY carry their URLs.
      .replace(/\?&+/g, "?")
      .replace(/&{2,}/g, "&")
      .replace(/[?&]+(["'])/g, "$1")
      .replace(/[?&]+$/gm, "")
  );
}

/** True if the text still contains anything that looks like a credential. */
export function containsCredential(text: string): boolean {
  CREDENTIAL_PARAMS.lastIndex = 0;
  return CREDENTIAL_PARAMS.test(text);
}
