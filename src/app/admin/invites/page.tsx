import type { Metadata } from "next";

import { InvitesWorkspace } from "./InvitesWorkspace";

export const metadata: Metadata = { title: "Invites · Curator" };

export default function AdminInvitesPage() {
  return <InvitesWorkspace />;
}
