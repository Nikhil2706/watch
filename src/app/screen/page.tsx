import { redirect } from "next/navigation";

import { AppBar } from "@/components/AppBar";
import { ScreenCode } from "@/components/remote/ScreenCode";
import { currentSession } from "@/lib/current-user";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Pair a phone · Watch",
};

/** The television-facing half of pairing: shows the code a phone types in. */
export default async function ScreenPage() {
  const session = await currentSession();
  if (!session) redirect("/login?next=/screen");

  return (
    <>
      <AppBar username={session.username} langloisMode={session.langloisMode} />
      <ScreenCode />
    </>
  );
}
