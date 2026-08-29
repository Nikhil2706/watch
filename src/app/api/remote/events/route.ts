import { subscribe, type RemoteCommand } from "@/lib/remote-bus";
import { getSessionFromRequest } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/remote/events?screenId=… — the TV's command stream (SSE).
 *
 * Server-Sent Events rather than a WebSocket because production fronts this
 * app with a remotely-managed Cloudflare tunnel whose ingress rules are not
 * editable from this machine; SSE is ordinary chunked HTTP to the same :3000
 * origin the tunnel already serves. See remote-bus.ts for the full reasoning.
 *
 * Two things keep the stream alive through intermediaries:
 *   - `X-Accel-Buffering: no`, which tells a buffering proxy not to hold
 *     chunks back (without it a proxy can sit on frames until the response
 *     ends, which for a stream is never).
 *   - a comment heartbeat every 20s, so an idle connection is not reaped as
 *     dead by the tunnel or the browser.
 */
const HEARTBEAT_MS = 20_000;

export async function GET(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const screenId = new URL(request.url).searchParams.get("screenId");
  if (!screenId) {
    return Response.json({ error: "invalid_request", message: "screenId is required." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: string) => {
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // Controller already closed (client vanished mid-write).
        }
      };

      unsubscribe = subscribe(screenId, session.userId, (command: RemoteCommand) => {
        send(`event: command\ndata: ${JSON.stringify(command)}\n\n`);
      });

      if (!unsubscribe) {
        // Unknown or not-owned screen. Tell the TV to re-register instead of
        // leaving it holding a stream that will never carry anything.
        send(`event: stale\ndata: {}\n\n`);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }

      // Flush something immediately: some proxies only commit to streaming
      // once the first bytes arrive, and the client's `open` event is what
      // tells the TV it is genuinely connected.
      send(`event: ready\ndata: ${JSON.stringify({ screenId })}\n\n`);

      heartbeatTimer = setInterval(() => send(`: keep-alive\n\n`), HEARTBEAT_MS);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  // Abort covers the case where the socket dies without `cancel` running.
  request.signal.addEventListener("abort", () => {
    unsubscribe?.();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
