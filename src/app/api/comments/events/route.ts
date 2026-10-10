import { subscribeComments } from "@/lib/comment-bus";
import { getSessionFromRequest } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/comments/events?imdbId=… — one film's comments, live (SSE).
 *
 * Sends `changed` whenever anyone posts, edits or deletes a comment on that
 * film; the page answers by reading the thread again from /api/comments.
 * Sends `presence` with how many people have the page open, on arrival and
 * whenever that number changes.
 * Server-Sent Events for the same reason the phone remote uses them: plain
 * chunked HTTP, which the tunnel in front of the site already carries. See
 * the remote's events route for the two headers and the heartbeat.
 */
const HEARTBEAT_MS = 20_000;

export async function GET(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const imdbId = new URL(request.url).searchParams.get("imdbId");
  if (!imdbId || imdbId.length > 40) {
    return Response.json({ error: "invalid_request", message: "imdbId is required." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    unsubscribe?.();
    unsubscribe = null;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Controller already closed (client vanished mid-write).
        }
      };
      // Something at once: some proxies only commit to streaming once the
      // first bytes arrive, and it is what tells the page it is connected.
      send(`event: ready\ndata: {}\n\n`);
      // Subscribing announces the new count to everyone, this page included.
      unsubscribe = subscribeComments(imdbId, {
        userId: session.userId,
        onChanged: () => send(`event: changed\ndata: {}\n\n`),
        onPresence: (here) => send(`event: presence\ndata: ${JSON.stringify({ here })}\n\n`),
      });
      heartbeatTimer = setInterval(() => send(`: keep-alive\n\n`), HEARTBEAT_MS);
    },
    cancel: stop,
  });

  // Abort covers the case where the socket dies without `cancel` running.
  request.signal.addEventListener("abort", stop);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
