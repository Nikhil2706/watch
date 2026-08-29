import { heartbeat, registerScreen, updateScreenState, type ScreenState } from "@/lib/remote-bus";
import { getSessionFromRequest } from "@/lib/session";
import { readJsonBody } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function unauthorised(): Response {
  return Response.json(
    { error: "unauthenticated", message: "Sign in to continue." },
    { status: 401, headers: NO_STORE },
  );
}

/**
 * POST /api/remote/screen — a TV announces itself and gets its pairing code.
 *
 * Called on load and again after any SSE reconnect. `screenId` is whatever the
 * TV kept in localStorage; passing it back keeps a phone's existing pairing
 * alive across reloads and gate restarts (the registry is in-memory — see
 * remote-bus.ts).
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) return unauthorised();

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBody(request);
  } catch {
    // A bodyless register is legitimate: a TV that has never registered has
    // no id to send.
  }

  const existingId = typeof body.screenId === "string" ? body.screenId : null;
  const name = typeof body.name === "string" ? body.name : null;

  const result = registerScreen({ userId: session.userId, existingId, name });
  return Response.json(result, { headers: NO_STORE });
}

/**
 * PUT /api/remote/screen — heartbeat plus "here is what I am showing".
 *
 * The TV posts this on navigation and while playing, so the phone can render
 * a real now-playing panel rather than guessing.
 */
export async function PUT(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) return unauthorised();

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  const screenId = typeof body.screenId === "string" ? body.screenId : null;
  if (!screenId) {
    return Response.json({ error: "invalid_request", message: "screenId is required." }, { status: 400, headers: NO_STORE });
  }

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 300) : null);

  const patch: Partial<ScreenState> = {
    href: str(body.href) ?? "/",
    itemId: str(body.itemId),
    title: str(body.title),
    subtitle: str(body.subtitle),
    posterUrl: str(body.posterUrl),
    positionSeconds: num(body.positionSeconds),
    durationSeconds: num(body.durationSeconds),
    paused: body.paused === true,
    playing: body.playing === true,
  };

  if (!updateScreenState(screenId, session.userId, patch)) {
    // The registry forgot this screen (restart, or swept). Tell the TV to
    // register again rather than silently dropping its updates.
    return Response.json({ error: "unknown_screen" }, { status: 404, headers: NO_STORE });
  }

  heartbeat(screenId, session.userId);
  return Response.json({ ok: true }, { headers: NO_STORE });
}
