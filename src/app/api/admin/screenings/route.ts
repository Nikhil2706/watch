import { requireAdmin } from "@/lib/admin-auth";
import { getAdminMovies } from "@/lib/admin-library-cache";
import { createScreening, listScreenings } from "@/lib/screening";
import { asRow, getDb } from "@/lib/db";
import { env } from "@/lib/env";

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

  /*
   * Attribution comes from the users table, not from a session.
   *
   * The console is a file:// page: it authenticates with the admin key header
   * and its cookies never reach the site, so currentSession() is always null
   * there. Requiring one would have made the Screening Room tab unable to
   * create anything, from the only UI that has it.
   *
   * The oldest account is the curator's — this instance's owner, created before
   * any invite existed.
   */
  const owner = asRow<{ id: string }>(
    getDb().prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get(),
  );
  if (!owner) {
    return Response.json({ error: "no users yet" }, { status: 409, headers: NO_STORE });
  }

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
    createdByUserId: owner.id,
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

  // env.publicUrl, not the request's own origin: behind the tunnel the gate
  // sees http://0.0.0.0:3000, so deriving it from the request would hand the
  // curator a link that cannot leave this machine. Same reason createInvite()
  // uses it.
  return Response.json(
    { id, url: `${env.publicUrl}/screening/${token}`, title: movie.Name },
    { headers: NO_STORE },
  );
}
