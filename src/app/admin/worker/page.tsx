import type { Metadata } from "next";

import { WorkerWorkspace } from "./WorkerWorkspace";

export const metadata: Metadata = { title: "Worker · Curator" };

export default function AdminWorkerPage() {
  return <WorkerWorkspace />;
}
