import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { PairApproveForm } from "@/components/tv/PairApproveForm";
import { currentSession } from "@/lib/current-user";

export const dynamic = "force-dynamic";

/**
 * The phone/laptop side of TV pairing. Reached either by typing
 * watch/pair, or by scanning the QR code a TV's login screen shows (which
 * encodes this same URL with ?code= already filled in).
 *
 * Ordinary session-gated page — if not signed in yet, the normal /login
 * flow runs first and lands back here afterward, same as any other
 * protected page linked from outside.
 */
export default async function PairPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const session = await currentSession();
  const { code } = await searchParams;
  const next = code ? `/pair?code=${encodeURIComponent(code)}` : "/pair";
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);

  return (
    <AuthShell pitch={false}>
      <h1 className="auth-title">Sign in on a TV</h1>
      <p className="auth-sub">
        Enter the code shown on your TV to sign this device in as{" "}
        <strong>{session.username}</strong>.
      </p>
      <PairApproveForm initialCode={code ?? ""} />
    </AuthShell>
  );
}
