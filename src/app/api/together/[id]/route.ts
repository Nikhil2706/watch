import { getItem } from "@/lib/media";
import { getSessionFromRequest } from "@/lib/session";
import { itemHref } from "@/lib/slugs";
import { readJsonBody } from "@/lib/validation";
import { answerAsk, getAsk, TogetherError } from "@/lib/watch-together";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/together/:id  { answer: "start" | "decline" }
 *
 * The asked friend's answer (watch-together.ts). "start" makes a watch party
 * with them in charge and answers `{ roomId }`; the asker is notified.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }
  const { id } = await context.params;
  let answer: unknown;
  try {
    answer = (await readJsonBody(request)).answer;
  } catch {
    answer = undefined;
  }
  if (answer !== "start" && answer !== "decline") {
    return Response.json({ error: "invalid_request", message: 'answer must be "start" or "decline".' }, { status: 400, headers: NO_STORE });
  }
  try {
    const ask = getAsk(id);
    if (!ask || ask.toUserId !== session.userId) throw new TogetherError("That invitation isn't yours.", 404);
    const item = answer === "start" ? await getItem(session, ask.itemId).catch(() => null) : null;
    if (answer === "start" && !item) throw new TogetherError("That title isn't in the library any more.", 409);
    const answered = answerAsk({
      askId: id,
      userId: session.userId,
      answer,
      film: {
        href: item ? itemHref(item.Id, item.Name, item.ProductionYear) : "/",
        imdbId: item?.ProviderIds?.Imdb ?? null,
      },
    });
    return Response.json({ ok: true, roomId: answered.roomId }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof TogetherError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: error.status, headers: NO_STORE });
    }
    console.error("[together] answer failed:", error);
    return Response.json({ error: "internal_error", message: "Could not do that." }, { status: 500, headers: NO_STORE });
  }
}
