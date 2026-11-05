import {
  accountsCookie,
  readDeviceAccounts,
  recentCookie,
  resolveDeviceAccounts,
  sessionCookie,
  withCookies,
} from "@/lib/session";
import { readJsonBody, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * POST /api/auth/switch  { userId } -> makes that account the active one.
 *
 * Only an account already signed in on this device can be chosen: the
 * session comes from the device's own list (jfg_accounts, httpOnly), never
 * from the request body, so knowing someone's user id gets you nothing. No
 * password, which is the point: a family TV switches with one press.
 * SameSite=Lax on both cookies keeps another site from posting here.
 */
export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    const body = await readJsonBody(request);
    if (typeof body.userId !== "string" || body.userId === "") {
      throw new ValidationError("userId is required.");
    }
    userId = body.userId;
  } catch (error) {
    const message = error instanceof ValidationError ? error.message : "Invalid request.";
    return Response.json({ error: "invalid_request", message }, { status: 400, headers: NO_STORE });
  }

  const { accounts, ids } = resolveDeviceAccounts(readDeviceAccounts(request));
  const chosen = accounts.find((a) => a.userId === userId);
  if (!chosen) {
    // Signed out, revoked or expired since the list was drawn. The list is
    // written back without it so the tile goes away.
    return Response.json(
      { error: "not_on_this_device", message: "That account is no longer signed in here. Sign in again to add it." },
      { status: 404, headers: withCookies(NO_STORE, [accountsCookie(ids)]) },
    );
  }

  return Response.json(
    { ok: true, username: chosen.username },
    { headers: withCookies(NO_STORE, [sessionCookie(chosen.sessionId), accountsCookie(ids), recentCookie()]) },
  );
}
