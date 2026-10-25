import { requireAdmin } from "@/lib/admin-auth";
import { autosyncOf, requestAutosync } from "@/lib/subtitle-autosync";
import { SyncError } from "@/lib/subtitle-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * "Sync automatically" (subtitle-autosync.ts).
 *
 *   GET  ?itemId=&name=   -> { autosync: { status, detail, ... } | null }
 *   POST { itemId, name } -> asks the worker to line that file up with its video
 */
function fail(error: unknown, what: string): Response {
  const known = error instanceof SyncError;
  if (!known) console.error(`[admin/subtitles/autosync] ${what} failed:`, error);
  return Response.json(
    { error: known ? "invalid_request" : "internal_error", message: error instanceof Error ? error.message : `Could not ${what}.` },
    { status: known ? 400 : 500, headers: NO_STORE },
  );
}

function missing(): Response {
  return Response.json({ error: "invalid_request", message: "itemId and name are required." }, { status: 400, headers: NO_STORE });
}

export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const itemId = url.searchParams.get("itemId");
  const name = url.searchParams.get("name");
  if (!itemId || !name) return missing();
  try {
    return Response.json({ autosync: await autosyncOf(itemId, name) }, { headers: NO_STORE });
  } catch (error) {
    return fail(error, "read the sync");
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = (await request.json().catch(() => ({}))) as { itemId?: unknown; name?: unknown };
  if (typeof b.itemId !== "string" || typeof b.name !== "string") return missing();
  try {
    return Response.json({ autosync: await requestAutosync(b.itemId, b.name) }, { headers: NO_STORE });
  } catch (error) {
    return fail(error, "ask for the sync");
  }
}
