import { currentSession } from "@/lib/current-user";
import { buildPick } from "@/lib/picker-data";
import type { PickMode } from "@/lib/picker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const MODES: readonly PickMode[] = ["new", "finish", "again", "random"];

function parseMode(value: string | null): PickMode {
  return MODES.includes(value as PickMode) ? (value as PickMode) : "new";
}

/**
 * GET /api/pick
 *
 * Returns a slate of ten, not one pick. Re-rolling then walks the slate in the
 * browser: instant, no second request, and no way for a stuck client to hammer
 * Jellyfin one film at a time.
 *
 * `exclude` carries the ids already offered this sitting. It comes from the
 * client's sessionStorage and is deliberately not remembered here — an offer
 * log is exactly the persistent per-person viewing record the metrics work was
 * parked over, and it would be built in service of a button.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await currentSession();
  if (!session) {
    return Response.json({ error: "not signed in" }, { status: 401, headers: NO_STORE });
  }

  const url = new URL(request.url);
  const exclude = new Set(
    (url.searchParams.get("exclude") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200), // a forged giant exclude list should not become a giant filter
  );

  const maxMinutesRaw = Number(url.searchParams.get("maxMinutes"));
  const seedRaw = Number(url.searchParams.get("seed"));

  try {
    const result = await buildPick(session, {
      mode: parseMode(url.searchParams.get("mode")),
      // A client-supplied seed keeps a re-roll reproducible if it retries;
      // absent one, any number will do.
      seed: Number.isFinite(seedRaw) && seedRaw > 0 ? Math.floor(seedRaw) : Date.now(),
      exclude,
      maxMinutes: Number.isFinite(maxMinutesRaw) && maxMinutesRaw > 0 ? maxMinutesRaw : undefined,
      genre: url.searchParams.get("genre") ?? undefined,
    });
    return Response.json(result, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "could not pick" }, { status: 500, headers: NO_STORE });
  }
}
