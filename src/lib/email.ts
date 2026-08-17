import "server-only";

import { logEvent, recordExternalApiCall } from "./events";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface InviteEmailInput {
  to: string;
  url: string;
  label: string | null;
  expiresAt: number;
}

export type SendInviteEmailResult =
  | { sent: true }
  | { sent: false; reason: string };

/**
 * Sends an invite link by email via Resend's HTTP API — a single fetch()
 * call, no SDK, the same "hand-roll it, don't add a dependency" approach
 * every scraping adapter in this project already uses. Configured with
 * RESEND_API_KEY + INVITE_EMAIL_FROM; if either is unset this is a no-op
 * that reports back why rather than throwing — email is a convenience
 * layered on top of the always-available "copy the link yourself" flow,
 * never something that should be able to break invite creation itself.
 *
 * Not Resend-specific by contract — createInvite()'s caller only sees
 * { sent, reason }. Swapping providers means rewriting the fetch() call
 * below, not touching anything upstream of this file.
 */
export async function sendInviteEmail(input: InviteEmailInput): Promise<SendInviteEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.INVITE_EMAIL_FROM?.trim();

  if (!apiKey || !from) {
    return {
      sent: false,
      reason: "Email isn't configured yet — set RESEND_API_KEY and INVITE_EMAIL_FROM to enable this.",
    };
  }

  const expiresText = new Date(input.expiresAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const subject = input.label ? `You're invited to Watch — ${input.label}` : "You're invited to Watch";

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject,
        html: buildInviteEmailHtml(input, expiresText),
        text: buildInviteEmailText(input, expiresText),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      recordExternalApiCall("resend", false);
      logEvent({
        category: "external_api",
        severity: "warning",
        source: "resend",
        message: `Invite email failed to send to ${input.to}`,
        detail: { status: response.status, body: body.slice(0, 500) },
      });
      return { sent: false, reason: `The email provider rejected the request (HTTP ${response.status}).` };
    }

    recordExternalApiCall("resend", true);
    return { sent: true };
  } catch (error) {
    recordExternalApiCall("resend", false);
    logEvent({
      category: "external_api",
      severity: "warning",
      source: "resend",
      message: `Invite email failed to send to ${input.to}`,
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    return { sent: false, reason: "Could not reach the email provider." };
  }
}

function buildInviteEmailText(input: InviteEmailInput, expiresText: string): string {
  return [
    "You've been invited to Watch, a private film club.",
    "",
    input.url,
    "",
    `This link works once and expires ${expiresText}.`,
  ].join("\n");
}

function buildInviteEmailHtml(input: InviteEmailInput, expiresText: string): string {
  const url = escapeHtml(input.url);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 20px;background:#06070a;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#f2f4f8;">
    <div style="max-width:420px;margin:0 auto;">
      <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.09em;color:#ffd9a0;margin:0 0 8px;">You've been invited</p>
      <h1 style="font-family:ui-serif,Georgia,'Times New Roman',serif;font-size:1.6rem;font-weight:600;margin:0 0 20px;">Watch</h1>
      <p style="font-size:15px;line-height:1.6;color:#dbe0ea;margin:0 0 24px;">A private film club, picked by people, not an algorithm. Here's your invite:</p>
      <a href="${url}" style="display:inline-block;background:#f2f4f8;color:#06070a;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;margin-bottom:24px;">Accept invite</a>
      <p style="font-size:12.5px;color:#939cad;line-height:1.6;margin:0;">This link works once and expires ${expiresText}. If the button doesn't work, copy this link:<br><span style="word-break:break-all;">${url}</span></p>
    </div>
  </body>
</html>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return text.replace(/[&<>"']/g, (c) => map[c] as string);
}
