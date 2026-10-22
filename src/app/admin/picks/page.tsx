import type { Metadata } from "next";

import { PicksWorkspace } from "./PicksWorkspace";

export const metadata: Metadata = { title: "Picks · Curator" };

export default function AdminPicksPage() {
  return <PicksWorkspace />;
}
