import { requireAdmin } from "@/lib/admin-auth";
import {
  createVersionSet,
  listVersionSets,
  makePrimaryVersion,
  removeFromVersionSet,
  setVersionLabel,
} from "@/lib/film-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

const bad = (message: string) =>
  Response.json({ error: "bad_request", message }, { status: 400, headers: NO_STORE });

async function body(request: Request): Promise<Record<string, unknown>> {
  return ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

const isPath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && v.length < 4096;

/** GET — every set of cuts, primary first. */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  return Response.json({ sets: listVersionSets() }, { headers: NO_STORE });
}

/**
 * POST { primaryPath, paths }
 *   Keeps these files as cuts of one film, listed as primaryPath. Labels are
 *   guessed from the filenames; PATCH renames.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = await body(request);
  const paths = Array.isArray(b.paths) ? b.paths.filter(isPath) : [];
  if (!isPath(b.primaryPath)) return bad("primaryPath is required.");
  if (paths.filter((p) => p !== b.primaryPath).length < 1) return bad("Choose at least one other file.");
  try {
    return Response.json({ ok: true, set: createVersionSet(b.primaryPath, paths) }, { headers: NO_STORE });
  } catch (error) {
    return bad(error instanceof Error ? error.message : "Could not save that.");
  }
}

/** PATCH { path, label } renames a cut; { path, makePrimary: true } lists it instead. */
export async function PATCH(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = await body(request);
  if (!isPath(b.path)) return bad("path is required.");
  try {
    let changed = false;
    if (typeof b.label === "string") changed = setVersionLabel(b.path, b.label) || changed;
    if (b.makePrimary === true) changed = makePrimaryVersion(b.path) || changed;
    if (!changed) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    return bad(error instanceof Error ? error.message : "Could not save that.");
  }
}

/** DELETE { path } — back to being a film of its own. */
export async function DELETE(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const b = await body(request);
  if (!isPath(b.path)) return bad("path is required.");
  const removed = removeFromVersionSet(b.path);
  return Response.json({ ok: removed }, { status: removed ? 200 : 404, headers: NO_STORE });
}
