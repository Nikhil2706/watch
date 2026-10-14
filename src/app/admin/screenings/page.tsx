import type { Metadata } from "next";

import { ScreeningsWorkspace } from "./ScreeningsWorkspace";

export const metadata: Metadata = { title: "Screening Room · Curator" };

export default function AdminScreeningsPage() {
  return <ScreeningsWorkspace />;
}
