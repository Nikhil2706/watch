import { getItem } from "@/lib/media";
import { notifyAllUsers } from "@/lib/notifications";
import { createPartyRoom } from "@/lib/party";
import { checkRateLimit, PARTY_CREATE_LIMIT, rateLimitHeaders } from "@/lib/ratelimit";
import { getSessionFromRequest } from "@/lib/session";
import { itemHref } from "@/lib/slugs";
import { optionalInt, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/party/create  { jellyfinId, scheduledAt? }
 *
 * scheduledAt (epoch ms) in the future creates a scheduled party — home
 * page shows it as "coming up" and runPartyScheduleTick() (library-notify.ts)
 * fires the "starting now" notification and flips it live at that time.
 * Omitted, or in the past, creates an instant party: live immediately, and
 * every user gets notified right now instead.
 */
export async function POST(request: Request): Promise<Response> {
  const session = getSessionFromRequest(request);
  if (!session) {
    return Response.json({ error: "unauthenticated", message: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  }

  const limit = checkRateLimit(PARTY_CREATE_LIMIT, session.sessionId);
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: `Slow down a little — try again in ${limit.retryAfterSeconds} seconds.` },
      { status: 429, headers: { ...NO_STORE, ...rateLimitHeaders(PARTY_CREATE_LIMIT, limit) } },
    );
  }

  try {
    const raw = await readJsonBody(request);
    const jellyfinId = optionalString(raw, "jellyfinId");
    const scheduledAtRaw = optionalInt(raw, "scheduledAt");
    if (!jellyfinId) throw new ValidationError("jellyfinId is required.");

    const item = await getItem(session, jellyfinId);
    if (!item) throw new ValidationError("That title isn't in the library.");

    const scheduledAt = scheduledAtRaw && scheduledAtRaw > Date.now() ? scheduledAtRaw : undefined;
    const room = createPartyRoom({
      jellyfinId: item.Id,
      filmTitle: item.Name,
      filmHref: itemHref(item.Id, item.Name, item.ProductionYear),
      creatorUserId: session.userId,
      scheduledAt,
    });

    notifyAllUsers({
      kind: scheduledAt ? "watch_party_scheduled" : "watch_party_live",
      imdbId: item.ProviderIds?.Imdb ?? item.Id,
      filmTitle: item.Name,
      filmHref: `/party/${room.id}`,
    });

    return Response.json({ room }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[party/create] failed:", error);
    return Response.json({ error: "internal_error", message: "Could not start the party." }, { status: 500, headers: NO_STORE });
  }
}
