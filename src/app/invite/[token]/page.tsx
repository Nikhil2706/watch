import Link from "next/link";

import { AuthShell } from "@/components/auth/AuthShell";
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
      <AuthShell pitch={false}>
        <h1 className="auth-title">This invite can&rsquo;t be used</h1>
        <p className="auth-sub">{status.reason}</p>
        <p className="auth-sub">
          Invites are single-use and time-limited, so this usually just means it
          sat too long or somebody already used it. Ask whoever sent it for a
          fresh one — it takes them a moment.
        </p>
        <div className="auth-foot">
          <p>
            Already have an account? <Link href="/login">Sign in</Link>.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    // No pitch here: an invite link means somebody already made the case for
    // the club in person. What is needed now is the form.
    <AuthShell pitch={false}>
      <p className="auth-eyebrow">You&rsquo;ve been invited</p>
      <h1 className="auth-title">Create your account</h1>
      <p className="auth-sub">
        {status.label
          ? `This invite was made out to ${status.label}.`
          : "Pick a username and password. That is the whole sign-up."}
      </p>

      <RedeemForm token={token} />

      <div className="auth-foot">
        <p>
          This link works once. Your username and password are yours alone —
          nobody running the club can see your password.
        </p>
      </div>
    </AuthShell>
  );
}
