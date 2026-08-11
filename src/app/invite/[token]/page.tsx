import { RedeemForm } from "@/components/RedeemForm";
import { peekInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

/**
 * GET /invite/<token>
 *
 * The check here is advisory — it renders a useful message for a dead link
 * instead of making the user fill in a form first. It is not the gate: the
 * authoritative, race-free check is the conditional UPDATE in `claimInvite`,
 * which runs when the form is submitted. Anything decided on this page is
 * already stale by the time the POST arrives.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const status = peekInvite(token);

  if (!status.valid) {
    return (
      <main className="center">
        <div className="card">
          <h1>Invite unavailable</h1>
          <p className="sub">{status.reason}</p>
          <p className="sub">
            Ask whoever sent you this link for a new one.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <div className="card">
        <h1>Create your account</h1>
        <p className="sub">
          {status.label
            ? `Invited as: ${status.label}`
            : "You've been invited. Pick a username and password."}
        </p>
        <RedeemForm token={token} />
      </div>
    </main>
  );
}
