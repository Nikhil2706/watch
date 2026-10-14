import type { Metadata } from "next";

import { UploadsWorkspace } from "./UploadsWorkspace";

export const metadata: Metadata = { title: "Uploads · Curator" };

export default function AdminUploadsPage() {
  return <UploadsWorkspace />;
}
