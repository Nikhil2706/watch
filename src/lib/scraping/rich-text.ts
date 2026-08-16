import "server-only";

/**
 * The only formatting a curator can apply to a blurb or trivia fact: six
 * inert inline tags, nothing else — bold, italic, underline, strikethrough,
 * subscript, superscript. Run on every write (curator-typed text, or text
 * composed by selecting passages in the reader) so stored content is safe
 * to render as trusted HTML on a page anyone can load. The attack surface
 * is these six tags with no attributes, not arbitrary markup — an allowed
 * tag is always reconstructed clean, so even `<b onclick="...">` loses the
 * attribute rather than being rejected outright.
 */

const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "sub", "sup"]);

export function sanitizeRichText(input: string): string {
  return input.replace(/<\/?([a-zA-Z0-9]+)[^>]*>/g, (full, rawTag: string) => {
    const tag = rawTag.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return "";
    return full.startsWith("</") ? `</${tag}>` : `<${tag}>`;
  });
}
