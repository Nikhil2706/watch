import "server-only";

import { getCached, getLink, tmdbImage } from "./tmdb-store";

/**
 * The artwork TMDB has for a film, read from the local store.
 *
 * The poster picker used to make two live TMDB calls every time it opened —
 * resolve the IMDb id, then fetch the images. That was the only option before
 * there was a store. There is one now, and it already holds **7,267 posters,
 * 8,716 backdrops and 903 logos** across the cached films: an average of twenty
 * posters per title, sitting on disk, while the picker went to the network for
 * them.
 *
 * On a link that drops one request in thirty, that is the difference between a
 * panel that opens instantly and one that sometimes says "no posters found" for
 * a film with twenty of them.
 *
 * Posters were also the only kind offered. Backdrops and logos are cached at
 * the same coverage and are the two the site has new uses for — a hero needs a
 * backdrop, and a title treatment needs a logo.
 */

export type ArtworkKind = "poster" | "backdrop" | "logo";

export interface ArtworkOption {
  /** Full-size, for handing to Jellyfin to download. */
  fullUrl: string;
  /** Small, for the picker grid. */
  thumbUrl: string;
  width: number;
  height: number;
  /** ISO 639-1, or null for a textless image — which is usually what you want for a backdrop. */
  language: string | null;
  voteAverage: number;
}

interface RawImage {
  file_path: string;
  width: number;
  height: number;
  iso_639_1: string | null;
  vote_average: number;
}

interface MoviePayload {
  images?: {
    posters?: RawImage[];
    backdrops?: RawImage[];
    logos?: RawImage[];
  };
}

/** Logos are PNG with transparency; asking for a JPEG size would flatten them onto black. */
const FULL_SIZE: Record<ArtworkKind, string> = {
  poster: "original",
  backdrop: "original",
  logo: "original",
};

const THUMB_SIZE: Record<ArtworkKind, string> = {
  poster: "w185",
  backdrop: "w300",
  logo: "w300",
};

function toOption(kind: ArtworkKind, img: RawImage): ArtworkOption | null {
  const fullUrl = tmdbImage(img.file_path, FULL_SIZE[kind]);
  const thumbUrl = tmdbImage(img.file_path, THUMB_SIZE[kind]);
  if (!fullUrl || !thumbUrl) return null;
  return {
    fullUrl,
    thumbUrl,
    width: img.width,
    height: img.height,
    language: img.iso_639_1 ?? null,
    voteAverage: img.vote_average ?? 0,
  };
}

/**
 * Ordered the way a curator would want to scan them: rated first.
 *
 * Deliberately NOT filtered by language. A poster is a matter of taste, and
 * this library is heavily French, Italian and Japanese — the original-language
 * poster is frequently the one worth having, so it should be in the grid rather
 * than filtered out for not being English.
 */
export function artworkFromCache(tmdbId: number, kind: ArtworkKind): ArtworkOption[] {
  const cached = getCached<MoviePayload>("movie", tmdbId);
  if (!cached) return [];

  const images = cached.payload.images ?? {};
  const raw = kind === "poster" ? images.posters : kind === "backdrop" ? images.backdrops : images.logos;

  return (raw ?? [])
    .slice()
    .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
    .map((img) => toOption(kind, img))
    .filter((x): x is ArtworkOption => x !== null);
}

export interface ArtworkSet {
  poster: ArtworkOption[];
  backdrop: ArtworkOption[];
  logo: ArtworkOption[];
  /** False when this film is not in the store at all, so the caller can say why rather than showing an empty grid. */
  cached: boolean;
}

/** Everything at once — the picker shows all three kinds as tabs, and it is one read. */
export function artworkForPath(path: string | null | undefined): ArtworkSet | null {
  if (!path) return null;
  const link = getLink("path", path);
  if (!link || link.tmdbKind !== "movie" || link.tmdbId <= 0) return null;
  return artworkForTmdbId(link.tmdbId);
}

export function artworkForTmdbId(tmdbId: number): ArtworkSet {
  const cached = getCached("movie", tmdbId) !== null;
  return {
    poster: artworkFromCache(tmdbId, "poster"),
    backdrop: artworkFromCache(tmdbId, "backdrop"),
    logo: artworkFromCache(tmdbId, "logo"),
    cached,
  };
}
