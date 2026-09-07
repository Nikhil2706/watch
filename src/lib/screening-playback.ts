import "server-only";

import { cached } from "./cache";
import { env } from "./env";
import { listJellyfinUsers } from "./jellyfin";
import type { ResolvedSession } from "./session";

/**
 * A ResolvedSession-shaped object for a screening guest.
 *
 * A screening recipient has no account, which is the whole point of the
 * feature, but getPlaybackPlan() needs a Jellyfin token, a device id and a
 * user id. It touches nothing else on the session, so this synthesises the
 * three and nothing more.
 *
 * The token is the API key — see the long note in the /jf proxy about why, and
 * about the allow-list that makes it safe. The device id is the screening
 * session's own, so Jellyfin's session list keeps two guests apart. The user id
 * is whichever administrator the API key already belongs to: PlaybackInfo needs
 * *a* user to resolve a media source, and nothing about that user's state is
 * read back — the guest's resume position lives in screening_progress, exactly
 * so one stranger's progress cannot leak into another's.
 */

/**
 * Cached hard: this is a fixed property of the server, and asking on every
 * screening page load would add a Jellyfin round trip to a guest's first
 * impression of the site.
 */
async function serviceUserId(): Promise<string | null> {
  return cached(
    "screening-service-user",
    "id",
    async () => {
      const users = await listJellyfinUsers();
      const admin = users.find((u) => u.Policy?.IsAdministrator === true) ?? users[0];
      return admin?.Id ?? null;
    },
    { ttlMs: 60 * 60 * 1000, staleMs: 24 * 60 * 60 * 1000 },
  );
}

export async function screeningSession(deviceId: string): Promise<ResolvedSession | null> {
  const userId = await serviceUserId();
  if (!userId) return null;

  return {
    sessionId: `screening:${deviceId}`,
    userId: `screening:${deviceId}`,
    username: "screening",
    jellyfinUserId: userId,
    jellyfinToken: env.jellyfinApiKey,
    jellyfinDeviceId: deviceId,
    expiresAt: Date.now() + 60 * 60 * 1000,
    langloisMode: false,
    // A screening is an explicit curatorial act — the curator chose this exact
    // film for this exact person — so the viewer-level content filter does not
    // apply. Same precedent as getItem() not applying filterVisible().
    parentalControl: false,
  };
}
