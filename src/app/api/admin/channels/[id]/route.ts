import { requireAdmin } from "@/lib/admin-auth";
import { channelGuide, deleteChannel, getChannel, getEntries, saveChannel, type ChannelEntry, type OrderMode } from "@/lib/channels";
import { optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const KINDS = new Set(["item", "group", "genre"]);

/** GET — the channel, its lineup as entered, and its guide from now. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const channel = getChannel(id);
  if (!channel) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  const guide = channelGuide(channel, Date.now(), 6).map((p) => ({ name: p.slot.name, startsAt: p.startedAtMs, endsAt: p.endsAtMs }));
  return Response.json({ channel, entries: getEntries(id), guide }, { headers: NO_STORE });
}

/** PUT { name, orderMode, entries: [{ kind, ref, label }] } — saves and works the lineup out again. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  if (!getChannel(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  try {
    const body = await readJsonBody(request);
    const name = optionalString(body, "name")?.trim();
    if (!name) throw new ValidationError("A channel needs a name.");
    const orderMode: OrderMode = optionalString(body, "orderMode") === "shuffle" ? "shuffle" : "in_order";
    const raw = (body as { entries?: unknown }).entries;
    if (!Array.isArray(raw)) throw new ValidationError("entries must be a list.");
    const entries: ChannelEntry[] = raw.map((e) => {
      const entry = e as Partial<ChannelEntry>;
      if (!entry || !KINDS.has(String(entry.kind)) || typeof entry.ref !== "string" || !entry.ref) {
        throw new ValidationError("Each entry needs a kind (item, group or genre) and a ref.");
      }
      return { kind: entry.kind as ChannelEntry["kind"], ref: entry.ref, label: String(entry.label ?? entry.ref) };
    });
    const built = await saveChannel(id, { name, orderMode, entries });
    return Response.json({ ok: true, ...built }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/channels] save failed:", error);
    return Response.json({ error: "internal_error", message: "Could not save the channel." }, { status: 500, headers: NO_STORE });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  return Response.json({ deleted: deleteChannel(id) }, { headers: NO_STORE });
}
