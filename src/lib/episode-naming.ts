import "server-only";

import { basename, extname } from "node:path";

/**
 * Episode ordering and naming for grouped multi-part titles.
 *
 * Groups like "Out 1" or "The Curse" are individual files that Jellyfin
 * matched (often wrongly, since it's searching each file as its own movie)
 * one at a time — nothing about that match is reliable for a part number or
 * a part title. The filename is: sources that already carry a season/episode
 * marker ("Ep 7", "S01E09") almost always carry it correctly, since that's
 * how the file was actually named before it was mis-matched.
 */

export interface ParsedEpisode {
  season: number | null;
  episode: number | null;
  /** Only set when real text follows the episode marker, not release noise. */
  title: string | null;
  /** Ascending sort key; unparsed files sort after every numbered one. */
  sortKey: number;
}

const UNPARSED_SORT_KEY = Number.MAX_SAFE_INTEGER;

// Same "strip the release-tag noise" list used for the search-box title
// guess in invites.html, kept in sync by hand since one lives in the browser
// and the other on the server.
const RELEASE_NOISE =
  /\b(1080p|2160p|720p|480p|4k|uhd|web[- ]?dl|webrip|bluray|blu[- ]?ray|brrip|bdrip|dvdrip|hdrip|hdtv|x264|x265|h ?264|h ?265|hevc|avc|aac\d*|ac3|dts|remux|proper|repack|amzn|nf|hulu|dsnp|multi|dual)\b/i;

const SEASON_EPISODE = /\bS(\d{1,2})E(\d{1,3})\b/i;
const BARE_EPISODE = /\bE(?:p(?:isode)?)?\.?\s*(\d{1,3})\b/i;

function cleanTitleFragment(fragment: string): string | null {
  // Cut at the first release-noise token — everything past it is quality/
  // codec/group noise, not part of a title.
  const noiseMatch = RELEASE_NOISE.exec(fragment);
  const cut = noiseMatch ? fragment.slice(0, noiseMatch.index) : fragment;

  const cleaned = cut
    .replace(/[._]+/g, " ")
    .replace(/^[\s\-–—:]+/, "")
    .replace(/[\s\-–—:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  // Too short to be a real title (a stray "1", a leftover bracket) — better
  // to show nothing than a fragment nobody would recognise as a title.
  if (cleaned.length < 3) return null;
  if (/^\d+$/.test(cleaned)) return null;
  return cleaned;
}

/** Parses a season/episode marker and any embedded title out of a filename or path. */
export function parseEpisodeInfo(pathOrFilename: string): ParsedEpisode {
  const filename = basename(pathOrFilename);
  const stem = filename.slice(0, filename.length - extname(filename).length);

  const seasonEp = SEASON_EPISODE.exec(stem);
  if (seasonEp) {
    const season = Number.parseInt(seasonEp[1] ?? "0", 10);
    const episode = Number.parseInt(seasonEp[2] ?? "0", 10);
    const rest = stem.slice(seasonEp.index + seasonEp[0].length);
    return {
      season,
      episode,
      title: cleanTitleFragment(rest),
      sortKey: season * 1000 + episode,
    };
  }

  const bareEp = BARE_EPISODE.exec(stem);
  if (bareEp) {
    const episode = Number.parseInt(bareEp[1] ?? "0", 10);
    const rest = stem.slice(bareEp.index + bareEp[0].length);
    return {
      season: null,
      episode,
      title: cleanTitleFragment(rest),
      sortKey: episode,
    };
  }

  return { season: null, episode: null, title: null, sortKey: UNPARSED_SORT_KEY };
}

/** "Episode 7", "Episode 7: Title", or null when no marker was found at all. */
export function episodeLabel(parsed: ParsedEpisode): string | null {
  if (parsed.episode === null) return null;
  const base = `Episode ${parsed.episode}`;
  return parsed.title ? `${base}: ${parsed.title}` : base;
}
