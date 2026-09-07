import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { createScreening, listScreenings } from "@/lib/screening";
import { currentSession } from "@/lib/current-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Every screening, newest first, for the console's Screening Room tab. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json({ screenings: listScreenings() }, { headers: NO_STORE });
}

/**
 * POST /api/admin/screenings
 *
 * Returns the URL ONCE. The plaintext token is never persisted and cannot be
 * recovered — same contract as createInvite().
 *
 * A screening deliberately bypasses the discovery filters: sending one is an
 * explicit curatorial act, and it should work for a title that is excluded,
 * rollout-hidden or marked as a special feature. Same precedent as getItem()
 * not applying filterVisible().
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const session = await currentSession();
  if (!session) return Response.json({ error: "not signed in" }, { status: 401, headers: NO_STORE });

  let body: {
    itemId?: string;
    recipientLabel?: string;
    recipientEmail?: string;
    message?: string;
    expiryDays?: number;
    windowHours?: number;
    windowStartsOn?: "open" | "play";
    maxDevices?: number;
    maxConcurrent?: number;
    stampName?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }

  if (!body.itemId) {
    return Response.json({ error: "itemId is required" }, { status: 400, headers: NO_STORE });
  }

  const movies = await getAdminMovies({ withMediaSources: false }).catch(() => []);
  const movie = movies.find((m) => m.Id === body.itemId);
  if (!movie) {
    return Response.json({ error: "no such item" }, { status: 404, headers: NO_STORE });
  }

  const { id, token } = createScreening({
    createdByUserId: session.userId,
    items: [
      {
        jellyfinItemId: movie.Id,
        // Both ride along because Jellyfin item ids are not stable across a
        // library rebuild; without them a screening quietly dies after the next
        // rescan, days after anyone would connect the two events.
        itemPath: movie.Path ?? null,
        imdbId: movie.ProviderIds?.Imdb ?? null,
        title: movie.Name,
      },
    ],
    recipientLabel: body.recipientLabel ?? null,
    recipientEmail: body.recipientEmail ?? null,
    message: body.message ?? null,
    expiryDays: body.expiryDays,
    windowHours: body.windowHours,
    windowStartsOn: body.windowStartsOn,
    maxDevices: body.maxDevices,
    maxConcurrent: body.maxConcurrent,
    stampName: body.stampName,
  });

  const origin = new URL(request.url).origin;
  return Response.json(
    { id, url: `${origin}/screening/${token}`, title: movie.Name },
    { headers: NO_STORE },
  );
}
