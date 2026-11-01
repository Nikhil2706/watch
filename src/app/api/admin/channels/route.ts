import { requireAdmin } from "@/lib/admin-auth";
import { channelOnNow, createChannel, getEntries, getSlots, listChannels, type OrderMode } from "@/lib/channels";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** GET /api/admin/channels — every channel, with its lineup's size and what is on (channels.ts). */
export async function GET(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const now = Date.now();
  const channels = listChannels().map((c) => {
    const slots = getSlots(c.id);
    return {
      ...c,
      entries: getEntries(c.id).length,
      programmes: slots.length,
      runtimeMs: slots.reduce((sum, s) => sum + s.runtimeMs, 0),
      onNow: channelOnNow(c, now)?.slot.name ?? null,
    };
  });
  return Response.json({ channels }, { headers: NO_STORE });
}

/** POST /api/admin/channels { name, orderMode? } — a new, empty channel. */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  try {
    const body = await readJsonBody(request);
    const name = optionalString(body, "name")?.trim();
    if (!name) throw new ValidationError("A channel needs a name.");
    const orderMode: OrderMode = optionalString(body, "orderMode") === "shuffle" ? "shuffle" : "in_order";
    return Response.json({ id: createChannel(name, orderMode) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/channels] create failed:", error);
    return Response.json({ error: "internal_error", message: "Could not create the channel." }, { status: 500, headers: NO_STORE });
  }
}
