/**
 * Wikipedia articles fetched as source rather than rendered text left raw
 * markup in the scraped passages — "{{Infobox film | name = Sympathy for Mr.
 * Vengeance | image = sfmvposter2.jpg | ..." quoted on the film page as if
 * it were a review. 72 articles and 58 blurb / 47 trivia passages were like
 * that on 2026-09-30. Passages that look like markup are never shown.
 */
const MARKUP = [
  /\{\{|\}\}/, // templates
  /\[\[|\]\]/, // wiki links
  /\|\s*[a-z_ ]{2,30}\s*=/i, // "| name = ..." template parameters
  /<ref[\s>]|<\/ref>/i, // footnotes
  /^\s*={2,}[^=]+={2,}\s*$/m, // "== Heading =="
];

export function looksLikeWikiMarkup(text: string): boolean {
  return MARKUP.some((pattern) => pattern.test(text));
}
