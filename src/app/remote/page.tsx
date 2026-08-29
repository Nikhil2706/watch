import { redirect } from "next/navigation";

import { RemoteClient } from "@/components/remote/RemoteClient";
import { currentSession } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Remote · Watch",
};

/**
 * Phone-as-remote. Deliberately does NOT render the AppBar: this page is used
 * one-handed, in the dark, while something is already playing on a television,
 * and site chrome would only compete with the controls for thumb space.
 *
 * Ownership is the whole authorisation model — the screen list is scoped to
 * this session's user, so signing in is all the pairing security there is (see
 * src/lib/remote-bus.ts).
 */
export default async function RemotePage() {
  const session = await currentSession();
  if (!session) redirect("/login?next=/remote");

  return <RemoteClient />;
}
