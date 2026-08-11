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
  } = {},
): Promise<T> {
  const { method = "GET", body, token, deviceId, expectJson = true } = init;

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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return jellyfinFetch<T>(`${path}${suffix}`, { token, deviceId });
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
