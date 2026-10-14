import { notFound, redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { currentSession } from "@/lib/current-user";

import { AdminNav } from "./AdminNav";
import { Toasts } from "./Toasts";

import "./admin.css";

export const dynamic = "force-dynamic";

/**
 * The curator's tools, inside the site: the console that was curator.html,
 * moving here a tab at a time (see AdminNav for which have). Behind the
 * normal sign-in, so it works from a phone on mobile data, and only for an
 * account with users.is_admin. Everyone else gets the site's 404: the page
 * does not admit to existing.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session) redirect("/login?next=/admin");
  if (!session.isAdmin) notFound();

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} isAdmin />
      <Toasts>
        <main className="adm">
          <AdminNav />
          {children}
        </main>
      </Toasts>
    </>
  );
}
