import { requireAdmin } from "@/lib/admin-auth";
import { describePickItems } from "@/lib/pick-admin";
import {
  deletePick,
  getPick,
  listPickItems,
  listPickRecipients,
  publishPick,
  setPickRecipients,
  unpublishPick,
  updatePick,
  type PickAudience,
} from "@/lib/picks";
import { optionalBoolean, optionalString, readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function notFound(): Response {
  return Response.json({ error: "not_found", message: "No such pick." }, { status: 404, headers: NO_STORE });
}

async function detail(id: string) {
  const pick = getPick(id);
  if (!pick) return null;
  return {
    pick,
    items: await describePickItems(listPickItems(id)),
    recipients: listPickRecipients(id),
  };
}

/** GET /api/admin/picks/{id} — the pick, every title in it, and who it is for. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  const data = await detail(id);
  return data ? Response.json(data, { headers: NO_STORE }) : notFound();
}

/**
 * PATCH /api/admin/picks/{id}
 *   { title?, subtitle?, ranked?, audience?, pinned?, recipients?: string[], status?: "live" | "draft" }
 *
 * One call saves the whole header of the editor. Publishing is `status:
 * "live"`; the people a personal pick is for are notified then, and anyone
 * added to a pick that is already live is notified when they are added.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  if (!getPick(id)) return notFound();

  try {
    const body = await readJsonBody(request);

    const title = optionalString(body, "title");
    if (title !== undefined && !title.trim()) throw new ValidationError("title cannot be empty.");

    const audience = body.audience;
    if (audience !== undefined && audience !== "everyone" && audience !== "people") {
      throw new ValidationError("audience must be everyone or people.");
    }
    const status = body.status;
    if (status !== undefined && status !== "live" && status !== "draft") {
      throw new ValidationError("status must be live or draft.");
    }
    const recipients = body.recipients;
    if (recipients !== undefined && !(Array.isArray(recipients) && recipients.every((r) => typeof r === "string"))) {
      throw new ValidationError("recipients must be an array of user ids.");
    }

    // Recipients first, so a pick switched to "chosen people" in the same
    // save already knows who they are when the audience change notifies.
    if (recipients !== undefined) setPickRecipients(id, recipients as string[]);

    updatePick(id, {
      title: title?.trim(),
      subtitle: body.subtitle === null ? null : optionalString(body, "subtitle"),
      ranked: optionalBoolean(body, "ranked"),
      audience: audience as PickAudience | undefined,
      pinned: optionalBoolean(body, "pinned"),
    });

    let notified = 0;
    if (status === "live") {
      const pick = getPick(id)!;
      if (pick.audience === "people" && listPickRecipients(id).length === 0) {
        throw new ValidationError("Choose who this pick is for before publishing it.");
      }
      if (listPickItems(id).length === 0) {
        throw new ValidationError("Add at least one title before publishing.");
      }
      notified = publishPick(id);
    } else if (status === "draft") {
      unpublishPick(id);
    }

    return Response.json({ ok: true, notified, ...(await detail(id)) }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ValidationError) {
      return Response.json({ error: "invalid_request", message: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[admin/picks] update failed:", error);
    return Response.json(
      { error: "internal_error", message: "Could not save the pick." },
      { status: 500, headers: NO_STORE },
    );
  }
}

/** DELETE /api/admin/picks/{id} — gone from every page, with its notifications. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;
  const { id } = await params;
  return deletePick(id) ? Response.json({ ok: true }, { headers: NO_STORE }) : notFound();
}
