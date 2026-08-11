import { redirect } from "next/navigation";

import { LoginForm } from "@/components/LoginForm";
import { currentSession } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await currentSession();
  if (session) redirect("/");

  const params = await searchParams;

  // Open-redirect guard. Only a same-origin absolute path is accepted; a value
  // like `//evil.example` or `https://evil.example` is discarded. Without this,
  // a crafted ?next= would bounce a freshly authenticated user off-site.
  const requested = params.next ?? "/";
  const next =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  return (
    <main className="center">
      <div className="card">
        <h1>Sign in</h1>
        <p className="sub">Use the account you created from your invite.</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
