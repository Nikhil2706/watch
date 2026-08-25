import "server-only";

import { env } from "./env";

/**
 * Thin client for the OpenSubtitles.com REST API.
 *
 * https://opensubtitles.stoplight.io/docs/opensubtitles-api
 *
 * Auth model, per their docs: a static "Api-Key" header identifies this app
 * (the "consumer"); a per-user JWT is only needed for two things — /infos/user
 * and /download once past the anonymous quota. This app never asks anyone
 * for their OpenSubtitles credentials (the docs explicitly warn against
 * hardcoding a developer's own login into a distributed app), so it only
 * ever sends the Api-Key — that's enough for unlimited search and, with the
 * consumer flagged "Under Development" in the OpenSubtitles dashboard, up to
 * 100 downloads/day with no user login at all. If that ever needs to grow
 * past a private film club's usage, the natural next step is a dedicated
 * OpenSubtitles account whose username/password live in this same server-
 * only env layer (never in the browser) and a real login step here — not
 * implemented, since the dev-mode quota comfortably covers this library.
 */

const BASE_URL = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "Watch v0.1";
const REQUEST_TIMEOUT_MS = 15_000;

export class OpenSubtitlesError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "OpenSubtitlesError";
  }
}

export function isOpenSubtitlesConfigured(): boolean {
  return env.opensubtitlesApiKey !== "";
}

async function osFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  if (!env.opensubtitlesApiKey) {
    throw new OpenSubtitlesError("OPENSUBTITLES_API_KEY is not configured.", 0, "");
  }

  const { method = "GET", body, timeoutMs = REQUEST_TIMEOUT_MS } = init;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Api-Key": env.opensubtitlesApiKey,
    "User-Agent": USER_AGENT,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (cause) {
    throw new OpenSubtitlesError(
      `Could not reach OpenSubtitles: ${cause instanceof Error ? cause.message : String(cause)}`,
      0,
      "",
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new OpenSubtitlesError(
      `OpenSubtitles ${method} ${path} failed with ${response.status}`,
      response.status,
      text.slice(0, 500),
    );
  }
  if (text.trim() === "") return undefined as T;
  return JSON.parse(text) as T;
}

export interface OpenSubtitlesResult {
  id: string;
  language: string;
  downloadCount: number;
  hearingImpaired: boolean;
  hd: boolean;
  fromTrusted: boolean;
  aiTranslated: boolean;
  machineTranslated: boolean;
  release: string | null;
  /** What actually gets downloaded — one subtitle can ship as several CD-split files; the first is what a normal single-file movie needs. */
  fileId: number | null;
  fileName: string | null;
}

interface RawSearchResponse {
  total_count: number;
  data: Array<{
    id: string;
    attributes: {
      language: string;
      download_count: number;
      hearing_impaired: boolean;
      hd: boolean;
      from_trusted: boolean;
      ai_translated: boolean;
      machine_translated: boolean;
      release: string | null;
      files: Array<{ file_id: number; file_name: string }>;
    };
  }>;
}

/**
 * Searches by IMDb id — the precise, unambiguous lookup the docs recommend
 * over a text query whenever an id is available, which Jellyfin already
 * gives this app for nearly every film in the library.
 */
export async function searchSubtitlesByImdbId(
  imdbId: string,
  languages: string,
): Promise<OpenSubtitlesResult[]> {
  const params = new URLSearchParams({
    imdb_id: imdbId,
    languages,
    type: "movie",
    machine_translated: "exclude",
  });
  const data = await osFetch<RawSearchResponse>(`/subtitles?${params.toString()}`);
  return data.data.map((row) => {
    const file = row.attributes.files[0];
    return {
      id: row.id,
      language: row.attributes.language,
      downloadCount: row.attributes.download_count,
      hearingImpaired: row.attributes.hearing_impaired,
      hd: row.attributes.hd,
      fromTrusted: row.attributes.from_trusted,
      aiTranslated: row.attributes.ai_translated,
      machineTranslated: row.attributes.machine_translated,
      release: row.attributes.release,
      fileId: file?.file_id ?? null,
      fileName: file?.file_name ?? null,
    };
  });
}

/**
 * From a set of search results, the one worth downloading automatically:
 * not hearing-impaired (a viewer who specifically wants SDH can search by
 * hand), not machine-translated (already excluded from the search itself,
 * but kept here as a second guard), preferring a trusted uploader, then
 * simply the most-downloaded — the community's own signal for "this one is
 * actually in sync and readable."
 */
export function pickBestMatch(results: OpenSubtitlesResult[]): OpenSubtitlesResult | null {
  const candidates = results.filter((r) => !r.hearingImpaired && !r.machineTranslated && r.fileId !== null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => {
    if (a.fromTrusted !== b.fromTrusted) return a.fromTrusted ? -1 : 1;
    return b.downloadCount - a.downloadCount;
  })[0]!;
}

interface RawFeatureResponse {
  data: Array<{
    id: string;
    attributes: {
      title: string;
      year: string;
      subtitles_count: number;
      subtitles_counts: Record<string, number>;
    };
  }>;
}

/**
 * How many subtitles exist for a title at all — a cheap availability check
 * (same "Api-Key only, no per-download quota" tier as search), used to show
 * "N subtitles available" before a viewer commits to a fetch, or to skip
 * offering the button at all when the answer is zero.
 */
export async function getFeatureSubtitleCount(
  imdbId: string,
  language: string,
): Promise<{ total: number; forLanguage: number } | null> {
  const params = new URLSearchParams({ imdb_id: imdbId });
  const data = await osFetch<RawFeatureResponse>(`/features?${params.toString()}`);
  const attributes = data.data[0]?.attributes;
  if (!attributes) return null;
  return {
    total: attributes.subtitles_count,
    forLanguage: attributes.subtitles_counts[language] ?? 0,
  };
}

interface RawDownloadResponse {
  link: string;
  file_name: string;
  requests: number;
  remaining: number;
  message: string;
}

export interface SubtitleDownload {
  content: string;
  fileName: string;
  remaining: number;
}

/**
 * The two-step download the API requires: request a temporary (3-hour) URL
 * for a file_id — this is the action that actually consumes a unit of the
 * daily quota — then fetch the real content from it.
 */
export async function downloadSubtitle(fileId: number): Promise<SubtitleDownload> {
  const requested = await osFetch<RawDownloadResponse>("/download", {
    method: "POST",
    body: { file_id: fileId },
  });

  const fileResponse = await fetch(requested.link, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!fileResponse.ok) {
    throw new OpenSubtitlesError(
      `Fetching the downloaded subtitle file failed with ${fileResponse.status}`,
      fileResponse.status,
      "",
    );
  }

  return {
    content: await fileResponse.text(),
    fileName: requested.file_name,
    remaining: requested.remaining,
  };
}
