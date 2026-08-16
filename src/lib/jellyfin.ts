import "server-only";

import { randomBytes } from "node:crypto";

import { env } from "./env";

/**
 * Thin client for the Jellyfin REST API.
 *
 * Jellyfin is the identity source of truth. This app never stores or verifies a
 * password — it forwards credentials to Jellyfin once, at login, and from then
 * on holds only the access token Jellyfin issued.
 */

const CLIENT_NAME = "JellyfinGate";
const CLIENT_VERSION = "0.1.0";
const DEVICE_NAME = "Web";

/** Jellyfin can be slow to start; fail loudly rather than hanging a request. */
const REQUEST_TIMEOUT_MS = 15_000;

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

export interface JellyfinUser {
  Id: string;
  Name: string;
  Policy?: Record<string, unknown>;
}

export interface AuthenticationResult {
  User: JellyfinUser;
  AccessToken: string;
  ServerId?: string;
}

/**
 * Jellyfin tracks sessions by DeviceId. Issuing a fresh one per login means
 * logging out on a phone does not tear down the Jellyfin session held by a
 * laptop, and it keeps Jellyfin's own "Devices" list meaningful.
 */
export function generateDeviceId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Builds Jellyfin's bespoke Authorization header.
 *
 * Field values are wrapped in quotes and Jellyfin's parser has no escaping, so
 * every interpolated value must be quote-free. DeviceId is base64url and the
 * rest are compile-time constants, so that holds — but strip defensively rather
 * than trust it, since a malformed header would be attributed to the wrong
 * device.
 */
function authHeader(options: { token?: string; deviceId?: string }): string {
  const deviceId = (options.deviceId ?? "jellyfin-gate-admin").replace(/["\\,]/g, "");
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="${DEVICE_NAME}"`,
    `DeviceId="${deviceId}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (options.token) {
    parts.push(`Token="${options.token.replace(/["\\,]/g, "")}"`);
  }
  return `MediaBrowser ${parts.join(", ")}`;
}

async function jellyfinFetch<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string;
    deviceId?: string;
    expectJson?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const { method = "GET", body, token, deviceId, expectJson = true, timeoutMs = REQUEST_TIMEOUT_MS } = init;

  const headers: Record<string, string> = {
    Authorization: authHeader({ token, deviceId }),
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${env.jellyfinUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (cause) {
    throw new JellyfinError(
      `Could not reach Jellyfin at ${env.jellyfinUrl}${path}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      0,
      "",
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new JellyfinError(
      `Jellyfin ${method} ${path} failed with ${response.status}`,
      response.status,
      text.slice(0, 500),
    );
  }

  if (!expectJson || response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  if (text.trim() === "") return undefined as T;
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ *
 * User-scoped calls
 * ------------------------------------------------------------------ */

/**
 * Exchanges a username and password for a Jellyfin access token.
 *
 * This is the only place a user password exists in this process, and it is
 * never written anywhere — not to the database, not to a log.
 */
export async function authenticateByName(
  username: string,
  password: string,
  deviceId: string,
): Promise<AuthenticationResult> {
  return jellyfinFetch<AuthenticationResult>("/Users/AuthenticateByName", {
    method: "POST",
    // Jellyfin's field is `Pw`, not `Password`, on this endpoint specifically.
    body: { Username: username, Pw: password },
    deviceId,
  });
}

/**
 * Read-only request made with a *user's* token, for rendering the catalogue in
 * server components.
 *
 * This bypasses the /jf/* proxy on purpose. The proxy exists to let the browser
 * reach Jellyfin without ever holding a token; server-side rendering has no
 * such problem, and going straight to Jellyfin saves a pointless hop through
 * our own HTTP stack on every page render.
 *
 * The token still never leaves the server: only the rendered HTML does, and
 * image URLs in that HTML point back at /jf/*.
 */
export async function userFetch<T>(
  token: string,
  deviceId: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  timeoutMs?: number,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return jellyfinFetch<T>(`${path}${suffix}`, { token, deviceId, timeoutMs });
}

/** POST with a user's token. Used for PlaybackInfo negotiation. */
export async function userPost<T>(
  token: string,
  deviceId: string,
  path: string,
  body: unknown,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return jellyfinFetch<T>(`${path}${suffix}`, {
    method: "POST",
    body,
    token,
    deviceId,
  });
}

/** Invalidates the supplied access token on the Jellyfin side. */
export async function logout(token: string, deviceId: string): Promise<void> {
  await jellyfinFetch<void>("/Sessions/Logout", {
    method: "POST",
    token,
    deviceId,
    expectJson: false,
  });
}

/* ------------------------------------------------------------------ *
 * Admin-scoped calls (use JELLYFIN_API_KEY)
 * ------------------------------------------------------------------ */

export async function createUser(name: string): Promise<JellyfinUser> {
  // Created without a password, then the password is set in a second call.
  // Some Jellyfin builds ignore a `Password` field on /Users/New, and a user
  // silently created with an empty password would be a serious hole.
  return jellyfinFetch<JellyfinUser>("/Users/New", {
    method: "POST",
    body: { Name: name },
    token: env.jellyfinApiKey,
  });
}

export async function setUserPassword(
  userId: string,
  newPassword: string,
): Promise<void> {
  await jellyfinFetch<void>(`/Users/${encodeURIComponent(userId)}/Password`, {
    method: "POST",
    // An admin token may set a password without knowing the current one.
    body: { CurrentPw: "", NewPw: newPassword, ResetPassword: false },
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

export async function getUser(userId: string): Promise<JellyfinUser> {
  return jellyfinFetch<JellyfinUser>(`/Users/${encodeURIComponent(userId)}`, {
    token: env.jellyfinApiKey,
  });
}

export async function deleteUser(userId: string): Promise<void> {
  await jellyfinFetch<void>(`/Users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

/**
 * Applies the restricted policy for an invited user.
 *
 * Jellyfin's POST /Users/{id}/Policy *replaces* the whole policy object rather
 * than merging, so the existing policy is read first and overridden field by
 * field. Sending a partial object here would blank out defaults — including
 * library access — and leave the account unable to see anything.
 *
 * This policy is the primary authorisation boundary for everything a logged-in
 * user can do through the /jf/* proxy. Jellyfin itself enforces it on every
 * request; the proxy's deny-list is a second layer, not the only one.
 */
export async function applyRestrictedPolicy(userId: string): Promise<void> {
  const user = await getUser(userId);
  const existing = user.Policy ?? {};

  const policy: Record<string, unknown> = {
    ...existing,

    // --- Hard denials ---
    IsAdministrator: false,
    EnableLiveTvAccess: false,
    EnableLiveTvManagement: false,
    EnableContentDeletion: false,
    EnableContentDeletionFromFolders: [],
    EnableContentDownloading: false,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnableSubtitleManagement: false,
    EnableCollectionManagement: false,
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    ForceRemoteSourceTranscoding: false,
    SyncPlayAccess: "None",

    // --- Explicitly allowed ---
    IsDisabled: false,
    EnableRemoteAccess: true,
    EnableMediaPlayback: true,
    // Left on so clients that cannot direct-play still work. On an i3-6100 a
    // transcode is expensive; see the README note on capping concurrent
    // streams in Jellyfin itself if this becomes a problem.
    EnableAudioPlaybackTranscoding: true,
    EnableVideoPlaybackTranscoding: true,
    EnablePlaybackRemuxing: true,
    EnableAllDevices: true,
    EnableAllFolders: true,
    EnableUserPreferenceAccess: true,
  };

  await jellyfinFetch<void>(`/Users/${encodeURIComponent(userId)}/Policy`, {
    method: "POST",
    body: policy,
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

/**
 * Kicks off a full library scan so Jellyfin picks up files added or removed
 * on disk since the last scan. Fire-and-forget on Jellyfin's side — the
 * response returns before the scan finishes, so this only confirms the
 * request was accepted, not that it has completed.
 */
export async function refreshLibrary(): Promise<void> {
  await jellyfinFetch<void>("/Library/Refresh", {
    method: "POST",
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

/* ------------------------------------------------------------------ *
 * Library review — duplicate/metadata curation
 * ------------------------------------------------------------------ */

export interface RemoteSearchResult {
  Name: string;
  ProductionYear?: number;
  Overview?: string;
  ImageUrl?: string;
  ProviderIds: Record<string, string>;
  SearchProviderName?: string;
}

/**
 * Candidate matches for a title, straight from Jellyfin's own "Identify"
 * pipeline (whatever providers it has configured — TMDB, OMDb, etc). Used to
 * let an admin pick the right match by hand rather than trust whatever the
 * automatic scan guessed.
 */
export async function remoteSearchMovie(
  itemId: string,
  name: string,
  year?: number,
  providerIds?: { Imdb?: string; Tmdb?: string },
): Promise<RemoteSearchResult[]> {
  return jellyfinFetch<RemoteSearchResult[]>("/Items/RemoteSearch/Movie", {
    method: "POST",
    body: {
      ItemId: itemId,
      // When a provider id is given, it's an exact lookup — the provider
      // returns the one real title for that id rather than fuzzy-matching
      // on Name, so a search box that couldn't find something by title
      // (an oddly-parsed folder name) can still resolve it exactly.
      SearchInfo: { Name: name, Year: year, ProviderIds: providerIds },
      IncludeDisabledProviders: true,
    },
    token: env.jellyfinApiKey,
  });
}

/**
 * Applies one of remoteSearchMovie's candidates, replacing the item's
 * metadata — then locks Name and Overview so the next routine library scan
 * can't quietly re-guess and undo the correction.
 *
 * This is not a hypothetical: without the lock, "Parking" — matched here to
 * the real 1985 Jacques Demy film — reverted to its raw, un-parsed folder
 * name on the very next scan, because Jellyfin's automatic matcher couldn't
 * find *any* candidate for "parking_202408" and fell back to nothing. The fix
 * only holds if it's locked.
 *
 * Only Name and Overview here — "ProductionYear" and "ProviderIds" both
 * looked like reasonable members of Jellyfin's LockedFields enum and both
 * turned out not to be (400, verified against 10.11.11; the API reports only
 * the first invalid array element, so the ProviderIds rejection was hidden
 * behind the ProductionYear one until that got fixed first). Name+Overview
 * alone is enough to stop the regression this exists for.
 */
export async function applyRemoteSearchMatch(
  itemId: string,
  candidate: RemoteSearchResult,
): Promise<void> {
  await jellyfinFetch<void>(`/Items/RemoteSearch/Apply/${encodeURIComponent(itemId)}`, {
    method: "POST",
    body: candidate,
    token: env.jellyfinApiKey,
    expectJson: false,
  });

  const dto = await getFullItem(itemId);
  dto.LockData = true;
  const locked = new Set<string>(Array.isArray(dto.LockedFields) ? (dto.LockedFields as string[]) : []);
  locked.add("Name");
  locked.add("Overview");
  dto.LockedFields = [...locked];
  await jellyfinFetch<void>(`/Items/${encodeURIComponent(itemId)}`, {
    method: "POST",
    body: dto,
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

let cachedAdminUserId: string | null = null;

/**
 * An administrator's user id, needed for the `/Users/{id}/Items/{id}` shape —
 * the bare `/Items/{id}` endpoint 500s without a user in the path in this
 * Jellyfin version. Any admin works equally well here since this is only ever
 * used for admin-scoped metadata reads, never anything user-specific; cached
 * for the life of the process since the set of administrators rarely changes.
 */
async function getAdminUserId(): Promise<string> {
  if (cachedAdminUserId) return cachedAdminUserId;
  const users = await jellyfinFetch<Array<{ Id: string; Policy?: { IsAdministrator?: boolean } }>>(
    "/Users",
    { token: env.jellyfinApiKey },
  );
  const admin = users.find((u) => u.Policy?.IsAdministrator);
  if (!admin) throw new JellyfinError("No administrator account found.", 0, "");
  cachedAdminUserId = admin.Id;
  return admin.Id;
}

/** Full item DTO, editable and re-postable via updateItemMetadata. */
export async function getFullItem(itemId: string): Promise<Record<string, unknown>> {
  const userId = await getAdminUserId();
  return jellyfinFetch<Record<string, unknown>>(
    `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(itemId)}`,
    { token: env.jellyfinApiKey },
  );
}

/**
 * Hand-edits Name/Overview/ProductionYear on an item Jellyfin could never
 * match automatically (a YouTube rip, a home recording), and locks Name and
 * Overview so a later library scan doesn't overwrite them with nothing.
 *
 * ProductionYear is set but deliberately not added to LockedFields — Jellyfin
 * rejects that value in the enum outright (400, verified against 10.11.11).
 * There's nothing to re-guess it from for content with no provider match
 * anyway, so in practice it just stays whatever it's set to here.
 */
export async function setManualMetadata(
  itemId: string,
  patch: { name?: string; overview?: string; year?: number },
): Promise<void> {
  const dto = await getFullItem(itemId);
  if (patch.name !== undefined) dto.Name = patch.name;
  if (patch.overview !== undefined) dto.Overview = patch.overview;
  if (patch.year !== undefined) dto.ProductionYear = patch.year;
  dto.LockData = true;
  const locked = new Set<string>(Array.isArray(dto.LockedFields) ? (dto.LockedFields as string[]) : []);
  if (patch.name !== undefined) locked.add("Name");
  if (patch.overview !== undefined) locked.add("Overview");
  dto.LockedFields = [...locked];

  await jellyfinFetch<void>(`/Items/${encodeURIComponent(itemId)}`, {
    method: "POST",
    body: dto,
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

export interface OmdbEpisodeMetadata {
  name: string;
  overview?: string | null;
  genres?: string[];
  actors?: string[];
  director?: string[];
  writer?: string[];
  /** OMDb's rating, e.g. "7.1" — parsed and written to CommunityRating. */
  imdbRating?: string | null;
  /** This title's own IMDb id — replaces ProviderIds entirely rather than merging, since a Tmdb id left over from the original wrong match would otherwise survive alongside the newly-correct Imdb id. */
  imdbId?: string | null;
}

/**
 * Applies a full OMDb match — cast, crew, genres, rating, its own IMDb id —
 * to one file's Jellyfin item, not just its title. Once these fields exist
 * on the item, its own existing detail page (Hero, RatingsRow, CastRow)
 * renders them exactly as it would for a movie — no separate UI needed.
 *
 * RunTimeTicks is deliberately never touched here: verified against
 * 10.11.11 that Jellyfin silently ignores an update to it, keeping the
 * value it originally probed from the file itself — which is more accurate
 * than OMDb's rounded "58 min" text anyway.
 */
export async function applyOmdbEpisodeMetadata(itemId: string, patch: OmdbEpisodeMetadata): Promise<void> {
  const dto = await getFullItem(itemId);
  dto.Name = patch.name;
  if (patch.overview !== undefined) dto.Overview = patch.overview ?? undefined;
  if (patch.genres) dto.Genres = patch.genres;
  if (patch.imdbRating) {
    const rating = Number.parseFloat(patch.imdbRating);
    if (Number.isFinite(rating)) dto.CommunityRating = rating;
  }
  if (patch.imdbId) dto.ProviderIds = { Imdb: patch.imdbId };

  if (patch.actors || patch.director || patch.writer) {
    const people: Array<{ Name: string; Type: string }> = [];
    for (const name of patch.director ?? []) people.push({ Name: name, Type: "Director" });
    for (const name of patch.writer ?? []) people.push({ Name: name, Type: "Writer" });
    for (const name of patch.actors ?? []) people.push({ Name: name, Type: "Actor" });
    dto.People = people;
  }

  dto.LockData = true;
  const locked = new Set<string>(Array.isArray(dto.LockedFields) ? (dto.LockedFields as string[]) : []);
  locked.add("Name");
  if (patch.overview !== undefined) locked.add("Overview");
  dto.LockedFields = [...locked];

  await jellyfinFetch<void>(`/Items/${encodeURIComponent(itemId)}`, {
    method: "POST",
    body: dto,
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

/**
 * Sets an item's poster from a URL — Jellyfin fetches it server-side, so
 * this app never proxies or stores the image bytes itself. Used to replace
 * a mis-matched episode's poster with the real one from OMDb.
 */
export async function setItemImage(itemId: string, imageUrl: string): Promise<void> {
  const params = new URLSearchParams({ type: "Primary", imageUrl });
  await jellyfinFetch<void>(`/Items/${encodeURIComponent(itemId)}/RemoteImages/Download?${params.toString()}`, {
    method: "POST",
    token: env.jellyfinApiKey,
    expectJson: false,
  });
}

/**
 * Removes an item's Backdrop image, if it has one.
 *
 * media.ts's backdropUrl() reads BackdropImageTags before ever looking at
 * Primary — so an episode originally mis-matched to the wrong film kept
 * showing that film's backdrop on its own detail page even after
 * setItemImage() corrected the Primary poster. Deleting the stale backdrop
 * makes backdropUrl() fall through to the (now correct) Primary image.
 * 404 (nothing to delete) is not an error here.
 */
export async function clearItemBackdrop(itemId: string): Promise<void> {
  try {
    await jellyfinFetch<void>(`/Items/${encodeURIComponent(itemId)}/Images/Backdrop`, {
      method: "DELETE",
      token: env.jellyfinApiKey,
      expectJson: false,
    });
  } catch (error) {
    if (!(error instanceof JellyfinError && error.status === 404)) throw error;
  }
}

/** All movies, admin-scoped (no per-user watch data) — the review dashboard's data source. */
export interface AdminMovieListItem {
  Id: string;
  Name: string;
  ProductionYear?: number;
  Overview?: string;
  ProviderIds?: Record<string, string>;
  Path?: string;
  // Confirmed empirically: top-level items carry the tag nested under
  // ImageTags.Primary, unlike the flat PrimaryImageTag Jellyfin puts on
  // lightweight Person sub-objects (see AdminPersonCredit below) — these
  // are two different DTO shapes, not a Fields= gate.
  ImageTags?: { Primary?: string };
  MediaSources?: Array<{
    Container?: string;
    MediaStreams?: Array<{ Type: string; Codec?: string; Width?: number; Height?: number }>;
  }>;
}

export interface JellyfinHealth {
  reachable: boolean;
  responseMs: number | null;
  version: string | null;
  error?: string;
}

/** Cheap reachability + latency probe for the health dashboard. */
export async function checkJellyfinHealth(): Promise<JellyfinHealth> {
  const start = Date.now();
  try {
    const info = await jellyfinFetch<{ Version?: string }>("/System/Info", {
      token: env.jellyfinApiKey,
      timeoutMs: 5_000,
    });
    return { reachable: true, responseMs: Date.now() - start, version: info.Version ?? null };
  } catch (error) {
    return {
      reachable: false,
      responseMs: null,
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface JellyfinSessionSummary {
  signedIn: number;
  playing: number;
}

/** How many devices currently hold a Jellyfin session, and how many are mid-stream. */
export async function getActiveSessions(): Promise<JellyfinSessionSummary> {
  const sessions = await jellyfinFetch<Array<{ NowPlayingItem?: unknown }>>("/Sessions", {
    token: env.jellyfinApiKey,
    timeoutMs: 5_000,
  });
  return {
    signedIn: sessions.length,
    playing: sessions.filter((s) => s.NowPlayingItem != null).length,
  };
}

export async function listAllMoviesAdmin(): Promise<AdminMovieListItem[]> {
  const data = await jellyfinFetch<{ Items: AdminMovieListItem[] }>(
    // ImageTags.Primary arrives on every item by default — confirmed
    // empirically, not gated by Fields= like Overview/ProviderIds/etc are.
    "/Items?IncludeItemTypes=Movie&Recursive=true&Fields=Overview,ProviderIds,Path,ProductionYear,MediaSources&Limit=2000",
    // MediaSources pulls every stream (some titles carry 40+ subtitle tracks)
    // for the whole library in one call — genuinely heavier than the rest of
    // this client's traffic, so the default 15s budget isn't enough here.
    { token: env.jellyfinApiKey, timeoutMs: 90_000 },
  );
  return data.Items;
}

/** True if this item has no subtitle stream at all — embedded or external. */
export function hasNoSubtitles(item: AdminMovieListItem): boolean {
  const streams = item.MediaSources?.[0]?.MediaStreams ?? [];
  return !streams.some((s) => s.Type === "Subtitle");
}

export interface AdminPersonCredit {
  Name: string;
  Type: string;
  Id: string;
  PrimaryImageTag?: string;
}

/**
 * Every movie's cast/director credits, admin-scoped — used only to warm
 * Browse's SQLite people cache at boot (see instrumentation.ts), before any
 * user has a session to fetch it with. Fields=People alone costs Jellyfin
 * ~20 seconds against a few hundred titles regardless of what else is on
 * the request (measured directly this session), hence the same extended
 * timeout listAllMoviesAdmin needs for its own heavy pull.
 */
export async function getPeopleForAllMoviesAdmin(): Promise<Map<string, AdminPersonCredit[]>> {
  const data = await jellyfinFetch<{ Items: Array<{ Id: string; People?: AdminPersonCredit[] }> }>(
    "/Items?IncludeItemTypes=Movie&Recursive=true&Fields=People&Limit=2000",
    { token: env.jellyfinApiKey, timeoutMs: 90_000 },
  );
  const map = new Map<string, AdminPersonCredit[]>();
  for (const item of data.Items) map.set(item.Id, item.People ?? []);
  return map;
}
