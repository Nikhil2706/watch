/**
 * Human-readable /item and /watch URLs — "the-matrix-1999-<id>" instead of
 * a bare Jellyfin item id. The id (a 32-char hex GUID, no dashes — Jellyfin's
 * own format, e.g. "69e799ff3b4703c91d515e16b6855476") still does all the
 * real work: it's the last segment, extracted with a regex rather than
 * looked up in a slug table, so there is no slug-uniqueness problem to
 * solve and no migration needed for a link anyone already has. A bare old
 * link ("/item/69e799ff3b4703c91d515e16b6855476", no slug prefix at all)
 * still resolves the same way, since the id is still the string's only
 * trailing 32-hex-char run.
 */

const JELLYFIN_ID_PATTERN = /([0-9a-f]{32})$/i;

/** Pulls the real Jellyfin id off a route param, slugged or bare. Falls back to the param itself if it doesn't look like one of ours — never a hard failure here, the lookup that follows is what actually 404s. */
export function extractJellyfinId(param: string): string {
  const match = JELLYFIN_ID_PATTERN.exec(param);
  return match?.[1] ?? param;
}

// U+0300-U+036F: combining diacritical marks, split off by the NFKD
// normalize below (e.g. "Noel" + combining diaeresis, from "Noël").
const COMBINING_MARKS_PATTERN = /[̀-ͯ]/g;

function slugifyTitle(text: string): string {
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS_PATTERN, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, ""); // the length cut above can leave a trailing "-"
}

/** e.g. itemHref("69e7...", "The West Wing", 2021) -> "/item/the-west-wing-2021-69e7...". Falls back to a bare "/item/{id}" if the title slugifies to nothing (an all-symbols name, or none given). */
export function itemHref(id: string, name?: string | null, year?: number | null): string {
  const slug = name ? slugifyTitle(year ? `${name} ${year}` : name) : "";
  return slug ? `/item/${slug}-${id}` : `/item/${id}`;
}

/** Same slug, under /watch, with the existing ?t= resume-position param appended untouched. */
export function watchHref(id: string, name?: string | null, year?: number | null, resumeSeconds?: number): string {
  const slug = name ? slugifyTitle(year ? `${name} ${year}` : name) : "";
  const base = slug ? `/watch/${slug}-${id}` : `/watch/${id}`;
  return resumeSeconds && resumeSeconds > 0 ? `${base}?t=${resumeSeconds}` : base;
}
