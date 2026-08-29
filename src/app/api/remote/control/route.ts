import {
  claimByCode,
  getScreen,
  listScreens,
  renameScreen,
  sendCommand,
  type RemoteCommand,
} from "@/lib/remote-bus";
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
 * GET /api/remote/control          — list this account's screens.
 * GET /api/remote/control?screenId= — one screen, for now-playing polling.
 *
 * The phone polls this for state. State is the one thing that does NOT go
 * over SSE: the stream runs TV-ward (server pushes commands to the screen),
 * and adding a second stream phone-ward would double the long-lived
 * connections for a panel that only needs to move a progress bar. A short
 * poll is both simpler and cheaper here.
 */
export async function GET(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) return unauthorised();

  const screenId = new URL(request.url).searchParams.get("screenId");
  if (screenId) {
    const screen = getScreen(screenId, session.userId);
    if (!screen) {
      return Response.json({ error: "unknown_screen" }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ screen }, { headers: NO_STORE });
  }

  return Response.json({ screens: listScreens(session.userId) }, { headers: NO_STORE });
}

function parseCommand(body: Record<string, unknown>): RemoteCommand | null {
  const type = body.type;
  switch (type) {
    case "play":
    case "pause":
    case "playPause":
    case "back":
    case "reload":
    case "ping":
      return { type };
    case "navigate": {
      const href = typeof body.href === "string" ? body.href : "";
      // Same-origin paths only. A remote that can be talked into pointing the
      // television at an arbitrary external URL is an open redirect with a
      // screen attached.
      if (!href.startsWith("/") || href.startsWith("//")) return null;
      return { type: "navigate", href: href.slice(0, 500) };
    }
    case "seekTo": {
      const positionSeconds = body.positionSeconds;
      if (typeof positionSeconds !== "number" || !Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
      return { type: "seekTo", positionSeconds };
    }
    case "seekBy": {
      const deltaSeconds = body.deltaSeconds;
      if (typeof deltaSeconds !== "number" || !Number.isFinite(deltaSeconds)) return null;
      return { type: "seekBy", deltaSeconds };
    }
    default:
      return null;
  }
}

/**
 * POST /api/remote/control — pair with a screen, rename one, or drive one.
 *
 *   {action:"pair", code}                  -> {screen}
 *   {action:"rename", screenId, name}      -> {ok}
 *   {action:"command", screenId, ...cmd}   -> {delivered}
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) return unauthorised();

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  }

  if (body.action === "pair") {
    const code = typeof body.code === "string" ? body.code : "";
    const screen = claimByCode(code, session.userId);
    if (!screen) {
      return Response.json(
        { error: "no_match", message: "No screen is showing that code. Check the TV and try again." },
        { status: 404, headers: NO_STORE },
      );
    }
    return Response.json({ screen }, { headers: NO_STORE });
  }

  if (body.action === "rename") {
    const screenId = typeof body.screenId === "string" ? body.screenId : "";
    const name = typeof body.name === "string" ? body.name : "";
    if (!renameScreen(screenId, session.userId, name)) {
      return Response.json({ error: "unknown_screen" }, { status: 404, headers: NO_STORE });
    }
    return Response.json({ ok: true }, { headers: NO_STORE });
  }

  if (body.action === "command") {
    const screenId = typeof body.screenId === "string" ? body.screenId : "";
    const command = parseCommand(body);
    if (!command) {
      return Response.json({ error: "invalid_command" }, { status: 400, headers: NO_STORE });
    }
    const delivered = sendCommand(screenId, session.userId, command);
    if (!delivered) {
      // Distinguished from a 4xx on purpose: the command was well-formed and
      // authorised, the television just is not listening. The phone shows
      // "TV isn't connected" rather than "that didn't work".
      return Response.json(
        { delivered: false, message: "That screen isn't connected right now." },
        { status: 409, headers: NO_STORE },
      );
    }
    return Response.json({ delivered: true }, { headers: NO_STORE });
  }

  return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
}
