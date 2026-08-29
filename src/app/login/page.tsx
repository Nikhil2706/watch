import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth/AuthShell";
import { LoginScreen } from "@/components/tv/LoginScreen";
import { currentSession } from "@/lib/current-user";
import { resolveTvModeFromRequest } from "@/lib/tv/detect";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await currentSession();
  if (session) redirect("/");

  const tvMode = await resolveTvModeFromRequest();
  const params = await searchParams;

  // Open-redirect guard. Only a same-origin absolute path is accepted; a value
  // like `//evil.example` or `https://evil.example` is discarded. Without this,
  // a crafted ?next= would bounce a freshly authenticated user off-site.
  const requested = params.next ?? "/";
  const next =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  // Set when middleware bounced someone off a page they asked for, which
  // usually means their session ran out rather than that they arrived cold.
  const returning = next !== "/";

  return (
    <AuthShell>
      <h1 className="auth-title">Sign in</h1>
      <p className="auth-sub">
        {returning
          ? "Your session ended. Sign in and we'll take you back to where you were."
          : "Welcome back."}
      </p>

      <LoginScreen tvModeGuess={tvMode} next={next} />

      {/*
       * The page's second job. Most people who land here uninvited used to hit
       * a form they could not complete and no explanation — now they get told
       * how membership actually works, which is the only useful answer.
       */}
      <div className="auth-foot">
        <p>
          <strong>No account?</strong> Every account here starts with an invite
          from an existing member. Ask whoever told you about the club to send
          you a link.
        </p>
        {/*
         * Both remote routes are behind auth, so linking them here is about
         * discoverability, not access: they carry ?next= so signing in lands
         * you on the one you actually wanted instead of the home page. Someone
         * standing in front of a television wants "Use as TV"; someone holding
         * a phone wants "Use as remote".
         */}
        <p className="auth-remote-links">
          <a href="/login?next=%2Fremote">Use this phone as a remote</a>
          <span aria-hidden="true"> · </span>
          <a href="/login?next=%2Fscreen">Use this device as the TV</a>
        </p>
      </div>
    </AuthShell>
  );
}
