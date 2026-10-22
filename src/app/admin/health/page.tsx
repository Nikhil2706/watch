import type { Metadata } from "next";

import { HealthWorkspace } from "./HealthWorkspace";

export const metadata: Metadata = { title: "Health · Curator" };

export default function AdminHealthPage() {
  return <HealthWorkspace />;
}
