import type { Metadata } from "next";

import { ComingSoonWorkspace } from "./ComingSoonWorkspace";

export const metadata: Metadata = { title: "Coming soon · Curator" };

export default function AdminComingSoonPage() {
  return <ComingSoonWorkspace />;
}
